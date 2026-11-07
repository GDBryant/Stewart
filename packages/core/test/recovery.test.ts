import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "../src/channels/types.js";
import type { ChatMessage } from "@stewart/kernel";
import { ManagedChannel } from "../src/channels/registry.js";
import { EventBus } from "../src/events.js";
import { loadConfig, type Config } from "../src/config/effective.js";
import { counterIds, systemClock } from "@stewart/kernel";
import { RunManager } from "../src/runManager.js";
import { LeaseManager } from "@stewart/scheduling";
import { RunLedger, CostLimit } from "@stewart/ledger";
import { IdempotencyLog } from "../src/orchestration/idempotency.js";
import { actionsSoFar, classifyFault, countToolCalls, detectStuck } from "../src/orchestration/faults.js";
import {
  continueQuestion,
  mapContinueAnswer,
  parseRecoveryArgs,
  recoveryBrain,
  recoveryState,
  roleWithScratch,
  runTaskRecoverable,
  scratchGate,
  taskScratchDir,
} from "../src/orchestration/recovery.js";
import type { OrchestrationRuntime } from "../src/orchestration/types.js";
import { matchGlob } from "../src/roles.js";
import type { RoleDef } from "@stewart/config";
import { fakeHost } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";

const done = (usage?: { in: number; out: number }, costUsd?: number): ChatEvent => ({ kind: "done", usage, costUsd });
const text = (t: string): ChatEvent => ({ kind: "text", text: t });
const calls = (...c: { id: string; name: string; arguments: Record<string, unknown> }[]): ChatEvent => ({ kind: "tool_calls", calls: c });

type Script = (role: string, call: number, req: ChatRequest) => ChatEvent[];

function fakeChannel(script: Script): { channel: ManagedChannel; calls: string[] } {
  const seen: string[] = [];
  const counts: Record<string, number> = {};
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    async *chat(_cfg, _secret, req) {
      const first = req.messages[0];
      const sys = first && first.role === "system" ? first.content : "";
      const role = /ROLE:([a-z-]+)/.exec(sys)?.[1] ?? "(direct)";
      const n = (counts[role] = (counts[role] ?? 0) + 1);
      seen.push(`${role}#${n}`);
      for (const ev of script(role, n, req)) yield ev;
    },
  };
  const cfg = { id: "c1", type: "fake", enabled: true, maxParallel: 4, modelCaps: { m: { tools: "native" as const } } };
  return { channel: new ManagedChannel(adapter, cfg), calls: seen };
}

const CHANNELS = "version: 1\nitems:\n  - id: c1\n    type: fake\n    modelCaps:\n      m:\n        tools: native\n";
const AGENTS = `version: 1
items:
  - id: a-free
    channel: c1
    model: m
    billing: free
  - id: a-paid
    channel: c1
    model: m
    billing: reported
`;

function rolesYaml(over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    orchestrator: "enabled: true\n    agent: a-paid",
    "general-worker": "enabled: true\n    agent: a-free",
    investigator: "enabled: true\n    agent: a-free\n    tools: [ReadFile]",
  };
  const merged = { ...base, ...over };
  const items = Object.entries(merged)
    .map(([id, body]) => `  - id: ${id}\n    prompt: ROLE:${id}\n    ${body}`)
    .join("\n");
  return `version: 1\nitems:\n${items}\n`;
}

function config(opts: { roles?: Record<string, string>; settings?: string } = {}): Config {
  return loadConfig(
    { "channels.yaml": CHANNELS, "agents.yaml": AGENTS, "roles.yaml": rolesYaml(opts.roles), "settings.yaml": opts.settings },
    {},
    {},
    true,
  );
}

async function runtime(
  cfg: Config,
  channel: ManagedChannel,
  over: Partial<OrchestrationRuntime> & { files?: Record<string, string> } = {},
): Promise<{ rt: OrchestrationRuntime; events: RunEvent[]; files: Record<string, string> }> {
  const { files: extraFiles, ...rest } = over;
  const fake = fakeHost(extraFiles ?? { "a.ts": "a", "b.ts": "b" });
  const events: RunEvent[] = [];
  const bus = new EventBus((e) => events.push(e), 0);
  const ledger = new RunLedger(fake.host, "/tmp/st/ledger.jsonl", systemClock);
  await ledger.load();
  const idem = new IdempotencyLog(fake.host, "/tmp/st/scratch/run-1/executed.jsonl", "run-1");
  await idem.load();
  const rt: OrchestrationRuntime = {
    runId: "run-1",
    projectId: "p",
    host: fake.host,
    clock: systemClock,
    ids: counterIds(),
    bus,
    config: cfg,
    stateDir: "/tmp/st",
    channelFor: () => channel,
    ledger,
    leases: new LeaseManager(),
    idem,
    cost: new CostLimit(cfg.settings.costLimit.perRunUsd, cfg.settings.costLimit.onLimit),
    signal: new AbortController().signal,
    startedAt: systemClock.now(),
    leaseWaitMs: 50,
    skillBudgetTokens: 8000,
    maxNestedDispatches: cfg.settings.maxNestedDispatches,
    maxReplans: cfg.settings.maxReplans,
    maxRunHours: cfg.settings.maxRunHours,
    planGate: cfg.settings.planGate,
    ask: async () => "Stop this task",
    approve: async () => ({ kind: "approved" }),
    ...rest,
  };
  return { rt, events, files: fake.files };
}

const workerSpec = { id: "t1", roleId: "general-worker", title: "t", task: "do work", files: [] as string[], dependsOn: [] as string[] };
const TURNS_1 = "enabled: true\n    agent: a-free\n    turnBudget: 1";
const TURNS_2 = "enabled: true\n    agent: a-free\n    turnBudget: 2";

describe("classifyFault", () => {
  it("maps recoverable faults and ignores the rest", () => {
    const base: ChatMessage[] = [];
    expect(classifyFault({ kind: "completed", messages: [], base })).toBeUndefined();
    expect(classifyFault({ kind: "turn_limit", messages: [], base })).toBe("turn_limit");
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x", code: "truncated" })).toBe("truncated");
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x", code: "incomplete_stream" })).toBe("incomplete_stream");
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x", code: "auth" })).toBeUndefined();
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x" })).toBeUndefined();
  });
});

describe("detectStuck", () => {
  const msgs = (entries: [string, string, string][]): ChatMessage[] =>
    entries.flatMap(([name, arg, out], i) => [
      { role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name, arguments: { path: arg } }] } as ChatMessage,
      { role: "tool", toolCallId: `c${i}`, content: out } as ChatMessage,
    ]);

  it("flags 3+ identical calls", () => {
    const m = msgs([
      ["ReadFile", "a.ts", "ok"],
      ["ReadFile", "a.ts", "ok"],
      ["ReadFile", "a.ts", "ok"],
    ]);
    expect(detectStuck(m).stuck).toBe(true);
  });

  it("flags 5 turns without a successful progress call", () => {
    const m = msgs(Array.from({ length: 5 }, (_, i) => ["ReadFile", `f${i}.ts`, "ok"] as [string, string, string]));
    expect(detectStuck(m).stuck).toBe(true);
  });

  it("is not stuck on normal progress or fewer than 5 idle turns", () => {
    const progress = msgs([
      ["ReadFile", "a.ts", "ok"],
      ["WriteFile", "b.ts", "wrote"],
      ["ReadFile", "c.ts", "ok"],
      ["ReadFile", "d.ts", "ok"],
      ["ReadFile", "e.ts", "ok"],
    ]);
    expect(detectStuck(progress).stuck).toBe(false);
    const short = msgs([
      ["ReadFile", "a.ts", "ok"],
      ["ReadFile", "b.ts", "ok"],
    ]);
    expect(detectStuck(short).stuck).toBe(false);
  });
});

describe("actionsSoFar and countToolCalls", () => {
  it("lists successful calls only, capped", () => {
    const m: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "WriteFile", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", content: "wrote a.ts" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "ReadFile", arguments: { path: "b.ts" } }] },
      { role: "tool", toolCallId: "c2", content: "Error: missing" },
    ];
    expect(actionsSoFar(m, 20)).toEqual(["WriteFile a.ts"]);
    expect(countToolCalls(m)).toBe(2);
  });
});

describe("parseRecoveryArgs", () => {
  const lim = { maxSubTasks: 5, ceiling: 60 };
  it("accepts a valid plan", () => {
    const plan = parseRecoveryArgs(
      { subtasks: [{ description: "a", output_file: "o1.txt" }, { description: "b", output_file: "o2.txt", max_turns: 10 }], final_file: "out/f.txt", advice: "be small" },
      lim,
    );
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1].maxTurns).toBe(10);
    expect(plan.finalFile).toBe("out/f.txt");
  });

  it.each([
    [{}, "subtasks"],
    [{ subtasks: [{ description: "a", output_file: "o" }] }, "2..5"],
    [{ subtasks: Array.from({ length: 6 }, (_, i) => ({ description: `d${i}`, output_file: `o${i}` })) }, "2..5"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b" }] }, "output_file"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b", output_file: "x/y.txt" }] }, "bare file name"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b", output_file: "..o.txt" }] }, "bare file name"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b", output_file: "o2", max_turns: 61 }] }, "max_turns"],
  ])("rejects %j", (args, match) => {
    expect(() => parseRecoveryArgs(args, lim)).toThrow(match as string);
  });
});

describe("continueQuestion", () => {
  const spec = { id: "t1", roleId: "w", title: "t", task: "build the thing", files: [], dependsOn: [] };
  it("recommends Continue when not stuck, Split when stuck, and stays within ~600 chars", () => {
    const free = continueQuestion({ spec, turns: 7, transcript: [], maxActions: 20, canSplit: true });
    expect(free.options[0]).toBe("Continue (+7 turns)");
    expect(free.options).toContain("Split into smaller tasks");
    expect(free.question.length).toBeLessThanOrEqual(600);
    const stuckTx: ChatMessage[] = Array.from({ length: 3 }, (_, i) => [
      { role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "ReadFile", arguments: { path: "x" } }] } as ChatMessage,
      { role: "tool", toolCallId: `c${i}`, content: "ok" } as ChatMessage,
    ]).flat();
    const stuck = continueQuestion({ spec, turns: 7, transcript: stuckTx, maxActions: 20, canSplit: true });
    expect(stuck.options[0]).toBe("Split into smaller tasks");
  });

  it("offers only Continue/Stop when split is unavailable", () => {
    const q = continueQuestion({ spec, turns: 3, transcript: [], maxActions: 20, canSplit: false });
    expect(q.options).toEqual(["Continue (+3 turns)", "Stop this task"]);
  });

  it("maps answers", () => {
    expect(mapContinueAnswer("Continue (+3 turns)").kind).toBe("continue");
    expect(mapContinueAnswer("Split into smaller tasks").kind).toBe("split");
    expect(mapContinueAnswer("Stop this task").kind).toBe("stop");
    expect(mapContinueAnswer("try the other file").kind).toBe("text");
  });
});

describe("scratch helpers", () => {
  it("scratchGate approves only inside the task dir", async () => {
    const dir = taskScratchDir("run-1", "t1");
    const calls: string[] = [];
    const gate = scratchGate(dir, async (_c, p) => {
      calls.push(p?.kind === "file" ? p.path : "?");
      return { kind: "approved" };
    });
    const call = { id: "x", name: "WriteFile", arguments: { path: `${dir}/o.txt` } };
    expect((await gate(call, { kind: "file", path: `${dir}/o.txt`, before: null, after: "" }, { roleId: "w", taskId: "t1" })).kind).toBe("approved");
    expect(calls).toHaveLength(0);
    await gate(call, { kind: "file", path: "src/o.txt", before: null, after: "" }, { roleId: "w", taskId: "t1" });
    expect(calls).toEqual(["src/o.txt"]);
  });

  it("roleWithScratch extends non-empty writePaths and leaves unrestricted roles alone", () => {
    const role = (writePaths: string[]): RoleDef =>
      ({ id: "w", enabled: true, skills: [], tools: [], writePaths, turnBudget: 10 }) as RoleDef;
    expect(roleWithScratch(role([]), ".stewart/scratch/r/t").writePaths).toEqual([]);
    const r = roleWithScratch(role(["src/**"]), ".stewart/scratch/r/t");
    expect(matchGlob(".stewart/scratch/r/t/o.txt", ".stewart/scratch/r/t/o.txt")).toBe(true);
    expect(r.writePaths.some((g) => matchGlob(g, ".stewart/scratch/r/t/o.txt"))).toBe(true);
    expect(r.writePaths.some((g) => matchGlob(g, "other/o.txt"))).toBe(false);
  });
});

describe("runTaskRecoverable", () => {
  it("continues a worker past turn_limit when the user says Continue", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel, calls: seen } = fakeChannel((role, n) =>
      role === "general-worker"
        ? n === 1
          ? [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]
          : [text("finished"), done()]
        : [text("?"), done()],
    );
    const { rt } = await runtime(cfg, channel, {
      askTimed: async () => "Continue (+1 turns)",
    });
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const res = await runTaskRecoverable(rt, workerSpec, { role }, { depth: 0, brain: recoveryBrain(rt) });
    expect(res.status).toBe("done");
    expect(res.summary).toBe("finished");
    expect(seen).toEqual(["general-worker#1", "general-worker#2"]);
  });

  it("fails with 'stopped by user' when the user picks Stop", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    const { rt } = await runtime(cfg, channel, { askTimed: async () => "Stop this task" });
    const res = await runTaskRecoverable(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("stopped by user");
  });

  it("passes a free-text answer to the worker as a user message", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    let sawGuidance = false;
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "general-worker" && n === 2) {
        sawGuidance = req.messages.some((m) => m.role === "user" && m.content === "try b.ts instead");
        return [text("done"), done()];
      }
      return role === "general-worker" ? [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()] : [text("?"), done()];
    });
    const { rt } = await runtime(cfg, channel, { askTimed: async () => "try b.ts instead" });
    const res = await runTaskRecoverable(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
    expect(res.status).toBe("done");
    expect(sawGuidance).toBe(true);
  });

  it("does not ask when askOnTurnLimit is off", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 }, settings: "askOnTurnLimit: false" });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    let asked = 0;
    const { rt } = await runtime(cfg, channel, {
      askTimed: async () => {
        asked++;
        return "Continue (+1 turns)";
      },
    });
    const res = await runTaskRecoverable(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
    expect(asked).toBe(0);
    expect(res.status).toBe("stopped");
  });

  it("splits a worker via submit_recovery and assembles final_file", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_2 } });
    const { channel } = fakeChannel((role, n) => {
      if (role === "general-worker") {
        if (n <= 2) return [calls({ id: `w${n}`, name: "ReadFile", arguments: { path: `f${n}.ts` } }), done()];
        if (n === 3) return [calls({ id: "s1", name: "WriteFile", arguments: { path: `${taskScratchDir("run-1", "t1")}/o1.txt`, content: "content1" } }), done()];
        if (n === 4) return [text("part one done"), done()];
        if (n === 5) return [calls({ id: "s2", name: "WriteFile", arguments: { path: `${taskScratchDir("run-1", "t1")}/o2.txt`, content: "content2" } }), done()];
        return [text("part two done"), done()];
      }
      return [
        calls({
          id: "r1",
          name: "submit_recovery",
          arguments: {
            subtasks: [
              { description: "first half", output_file: "o1.txt" },
              { description: "second half", output_file: "o2.txt" },
            ],
            final_file: "out/final.txt",
          },
        }),
        done(),
      ];
    });
    const { rt, files } = await runtime(cfg, channel, { askTimed: async () => "Split into smaller tasks" });
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const res = await runTaskRecoverable(rt, workerSpec, { role }, { depth: 0, brain: recoveryBrain(rt) });
    expect(res.status).toBe("done");
    expect(res.summary).toContain("assembled -> out/final.txt");
    expect(files["out/final.txt"]).toBe("content1\ncontent2");
    expect(files[`${taskScratchDir("run-1", "t1")}/o1.txt`]).toBeUndefined();
    expect(files[`${taskScratchDir("run-1", "t1")}/o2.txt`]).toBeUndefined();
  });

  it("falls back to the original failure when the recovery call yields no plan, keeping scratch", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_2 } });
    const { channel } = fakeChannel((role) =>
      role === "general-worker" ? [calls({ id: "w", name: "ReadFile", arguments: { path: "a.ts" } }), done()] : [text("no plan"), done()],
    );
    const { rt } = await runtime(cfg, channel, { askTimed: async () => "Split into smaller tasks" });
    const res = await runTaskRecoverable(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0, brain: recoveryBrain(rt) });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("recovery: no valid submit_recovery");
    expect(res.summary).toContain(taskScratchDir("run-1", "t1"));
  });

  it("does not split beyond maxRecoveryDepth or when the profile disallows split", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel((role, n) =>
      role === "general-worker" ? [calls({ id: `w${n}`, name: "ReadFile", arguments: { path: "a.ts" } }), done()] : [text("no plan"), done()],
    );
    const { rt } = await runtime(cfg, channel, { askTimed: async () => "Split into smaller tasks" });
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const deep = await runTaskRecoverable(rt, workerSpec, { role }, { depth: 2, brain: recoveryBrain(rt) });
    expect(deep.status).toBe("stopped");
    const rt2 = { ...rt, budgetProfile: { turnMultiplier: 0.4, timeoutMultiplier: 0.5, allowSplit: false, maxRunMinutes: 10 } };
    const res = await runTaskRecoverable(rt2, workerSpec, { role }, { depth: 0, brain: recoveryBrain(rt) });
    expect(res.status).toBe("stopped");
  });

  it("retries a read-only level role once with the size hint instead of splitting", async () => {
    const cfg = config({ roles: { investigator: "enabled: true\n    agent: a-free\n    tools: [ReadFile]\n    turnBudget: 1" } });
    let hinted = false;
    const { channel } = fakeChannel((role, n, req) => {
      if (role !== "investigator") return [text("?"), done()];
      if (n === 1) return [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()];
      hinted = req.messages.some((m) => m.role === "user" && /output limit/.test(m.content));
      return [text("looked"), done()];
    });
    const { rt } = await runtime(cfg, channel);
    const spec = { ...workerSpec, roleId: "investigator" };
    const res = await runTaskRecoverable(rt, spec, { role: cfg.roles.find((r) => r.id === "investigator")! }, { depth: 0, brain: recoveryBrain(rt) });
    expect(res.status).toBe("done");
    expect(hinted).toBe(true);
  });

  it("retries incomplete_stream once with the same input", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_2 } });
    const { channel, calls: seen } = fakeChannel((role, n) =>
      role === "general-worker" ? (n === 1 ? [{ kind: "text", text: "partial" }] : [text("ok"), done()]) : [text("?"), done()],
    );
    const { rt } = await runtime(cfg, channel);
    const res = await runTaskRecoverable(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
    expect(res.status).toBe("done");
    expect(seen).toEqual(["general-worker#1", "general-worker#2"]);
  });
});

describe("RunManager direct continue question", () => {
  const agentOf = (cfg: Config) => cfg.agents.find((a) => a.id === "a-free")!;

  it("asks on turn limit and continues when the user answers", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel((role, n) =>
      n === 1 ? [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()] : [text("all done"), done()],
    );
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const bus = new EventBus((e) => events.push(e), 0);
    bus.subscribe(async (e) => {
      if (e.kind === "ask_user") manager.answer(e.questionId, e.options?.[0] ?? "Continue");
    });
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const run = await manager.direct("p", channel, agentOf(cfg), "go", undefined, role, "ROLE:general-worker", undefined, undefined, {
      config: cfg,
      profile: { turnMultiplier: 1, timeoutMultiplier: 1, allowSplit: true, maxRunMinutes: 0 },
      recovery: recoveryState(cfg.settings),
    });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    const q = events.find((e) => e.kind === "ask_user");
    expect(q).toBeDefined();
  });

  it("withdraws the question and stops when the continue question times out", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const instantClock = { now: () => Date.now(), setTimeout: (fn: () => void) => (queueMicrotask(fn), { cancel: () => {} }) };
    const manager = new RunManager({ host: fake.host, clock: instantClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const run = await manager.direct("p", channel, agentOf(cfg), "go", undefined, role, "ROLE:general-worker", undefined, undefined, {
      config: cfg,
      profile: { turnMultiplier: 1, timeoutMultiplier: 1, allowSplit: true, maxRunMinutes: 0 },
      recovery: recoveryState(cfg.settings),
    });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).not.toBe("running"));
    expect(manager.get(run.id)!.status).toBe("interrupted");
    expect(events.find((e) => e.kind === "question.withdrawn")).toBeDefined();
  });

  it("direct run keeps the full transcript on done and returns to idle (single-task pipeline)", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel(() => [text("hello there"), done()]);
    const fake = fakeHost({});
    const events: RunEvent[] = [];
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    const run = await manager.direct("p", channel, agentOf(cfg), "hi", undefined, undefined, undefined, undefined, undefined, {
      config: cfg,
      profile: { turnMultiplier: 1, timeoutMultiplier: 1, allowSplit: true, maxRunMinutes: 0 },
    });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    const msgs = manager.get(run.id)!.messages;
    expect(msgs[0]).toMatchObject({ role: "user", content: "hi" });
    expect(msgs.some((m) => m.role === "assistant" && m.content === "hello there")).toBe(true);
    expect(events.find((e) => e.kind === "run.finished")).toMatchObject({ status: "done" });
  });

  it("direct run is journaled with a single direct task and its agent id", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel(() => [text("hello"), done()]);
    const fake = fakeHost({});
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
    const run = await manager.direct("p", channel, agentOf(cfg), "hi there", undefined, undefined, undefined, undefined, undefined, {
      config: cfg,
      profile: { turnMultiplier: 1, timeoutMultiplier: 1, allowSplit: true, maxRunMinutes: 0 },
    });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    const j = JSON.parse(fake.files[`/tmp/st/scratch/${run.id}/run.json`]!);
    expect(j.agentId).toBe("a-free");
    expect(j.text).toBe("hi there");
    expect(j.tasks).toHaveLength(1);
    expect(j.tasks[0]).toMatchObject({ id: "direct", status: "done" });
  });

  it("resume of an interrupted direct run replays the original request on the journaled agent", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    let sent = 0;
    const { channel } = fakeChannel(() => (sent++, [text("resumed ok"), done()]));
    const fake = fakeHost({ "a.ts": "x" });
    fake.files["/tmp/st/scratch/run-d/run.json"] = JSON.stringify({
      id: "run-d",
      projectId: "p",
      text: "full original request",
      status: "interrupted",
      startedAt: 1,
      agentId: "a-free",
      tasks: [{ id: "direct", roleId: "chat", title: "t", task: "t", files: [], dependsOn: [], status: "failed", error: "x", filesTouched: [] }],
    });
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
    const res = await manager.resume("p", "run-d", { config: cfg, channelFor: () => channel });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(manager.get("run-d")?.status).toBe("done"));
    expect(sent).toBe(1);
    expect(manager.get("run-d")!.agentId).toBe("a-free");
  });

  it("resume of a completed direct run re-executes nothing", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    let sent = 0;
    const { channel } = fakeChannel(() => (sent++, [text("x"), done()]));
    const fake = fakeHost({});
    fake.files["/tmp/st/scratch/run-e/run.json"] = JSON.stringify({
      id: "run-e", projectId: "p", text: "go", status: "done", startedAt: 1, agentId: "a-free",
      tasks: [{ id: "direct", roleId: "chat", title: "t", task: "t", files: [], dependsOn: [], status: "done", filesTouched: [] }],
    });
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
    const res = await manager.resume("p", "run-e", { config: cfg, channelFor: () => channel });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(manager.get("run-e")?.status).toBe("done"));
    expect(sent).toBe(0);
  });

  it("direct run cancelled mid-stream ends cancelled, not done", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    const run = await manager.direct("p", channel, agentOf(cfg), "go", undefined, undefined, undefined, undefined, undefined, {
      config: cfg,
      profile: { turnMultiplier: 1, timeoutMultiplier: 1, allowSplit: true, maxRunMinutes: 0 },
    });
    manager.cancel(run.id);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "run.finished")).toBe(true));
    expect(manager.get(run.id)!.status).toBe("cancelled");
  });
});

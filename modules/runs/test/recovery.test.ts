import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "@stewart/channels";
import { ManagedChannel } from "@stewart/channels";
import { EventBus } from "@stewart/kernel";
import { loadConfig, type Config } from "@stewart/roles-skills";
import { counterIds, systemClock } from "@stewart/kernel";
import { RunService } from "../src/api.js";
import { LeaseManager } from "@stewart/scheduling";
import { RunLedger, CostLimit } from "@stewart/ledger";
import { IdempotencyLog } from "@stewart/run-state";
import { recoveryState } from "@stewart/agent-loop";
import { taskScratchDir, createRecovery } from "@stewart/recovery";
import { runRoleTask } from "@stewart/orchestration";
import type { OrchestrationRuntime } from "@stewart/agent-loop";
import { fakeHost } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";

const recoveryService = createRecovery(runRoleTask);

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
    recoveryService,
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
    prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Stop this task") }),
    approve: async () => ({ kind: "approved" }),
    ...rest,
  };
  return { rt, events, files: fake.files };
}

const workerSpec = { id: "t1", roleId: "general-worker", title: "t", task: "do work", files: [] as string[], dependsOn: [] as string[] };
const TURNS_1 = "enabled: true\n    agent: a-free\n    turnBudget: 1";
const TURNS_2 = "enabled: true\n    agent: a-free\n    turnBudget: 2";

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
      prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Continue (+1 turns)") }),
    });
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const res = await recoveryService.runTask(rt, workerSpec, { role }, { depth: 0, brain: recoveryService.brain(rt) });
    expect(res.status).toBe("done");
    expect(res.summary).toBe("finished");
    expect(seen).toEqual(["general-worker#1", "general-worker#2"]);
  });

  it("fails with 'stopped by user' when the user picks Stop", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    const { rt } = await runtime(cfg, channel, { prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Stop this task") }) })
    const res = await recoveryService.runTask(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
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
    const { rt } = await runtime(cfg, channel, { prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("try b.ts instead") }) })
    const res = await recoveryService.runTask(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
    expect(res.status).toBe("done");
    expect(sawGuidance).toBe(true);
  });

  it("does not ask when askOnTurnLimit is off", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 }, settings: "askOnTurnLimit: false" });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    let asked = 0;
    const { rt } = await runtime(cfg, channel, {
      prompt: async (p: { decode(a: string): unknown }) => {
        asked++;
        return { kind: "answered" as const, value: p.decode("Continue (+1 turns)") };
      },
    });
    const res = await recoveryService.runTask(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
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
    const { rt, files } = await runtime(cfg, channel, { prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Split into smaller tasks") }) })
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const res = await recoveryService.runTask(rt, workerSpec, { role }, { depth: 0, brain: recoveryService.brain(rt) });
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
    const { rt } = await runtime(cfg, channel, { prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Split into smaller tasks") }) })
    const res = await recoveryService.runTask(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0, brain: recoveryService.brain(rt) });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("recovery: no valid submit_recovery");
    expect(res.summary).toContain(taskScratchDir("run-1", "t1"));
  });

  it("does not split beyond maxRecoveryDepth or when the profile disallows split", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_1 } });
    const { channel } = fakeChannel((role, n) =>
      role === "general-worker" ? [calls({ id: `w${n}`, name: "ReadFile", arguments: { path: "a.ts" } }), done()] : [text("no plan"), done()],
    );
    const { rt } = await runtime(cfg, channel, { prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Split into smaller tasks") }) })
    const role = cfg.roles.find((r) => r.id === "general-worker")!;
    const deep = await recoveryService.runTask(rt, workerSpec, { role }, { depth: 2, brain: recoveryService.brain(rt) });
    expect(deep.status).toBe("stopped");
    const rt2 = { ...rt, budgetProfile: { turnMultiplier: 0.4, timeoutMultiplier: 0.5, allowSplit: false, maxRunMinutes: 10 } };
    const res = await recoveryService.runTask(rt2, workerSpec, { role }, { depth: 0, brain: recoveryService.brain(rt) });
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
    const res = await recoveryService.runTask(rt, spec, { role: cfg.roles.find((r) => r.id === "investigator")! }, { depth: 0, brain: recoveryService.brain(rt) });
    expect(res.status).toBe("done");
    expect(hinted).toBe(true);
  });

  it("retries incomplete_stream once with the same input", async () => {
    const cfg = config({ roles: { "general-worker": TURNS_2 } });
    const { channel, calls: seen } = fakeChannel((role, n) =>
      role === "general-worker" ? (n === 1 ? [{ kind: "text", text: "partial" }] : [text("ok"), done()]) : [text("?"), done()],
    );
    const { rt } = await runtime(cfg, channel);
    const res = await recoveryService.runTask(rt, workerSpec, { role: cfg.roles.find((r) => r.id === "general-worker")! }, { depth: 0 });
    expect(res.status).toBe("done");
    expect(seen).toEqual(["general-worker#1", "general-worker#2"]);
  });
});

describe("RunService direct continue question", () => {
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
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
    const manager = new RunService({ host: fake.host, clock: instantClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    const run = await manager.direct("p", channel, agentOf(cfg), "go", undefined, undefined, undefined, undefined, undefined, {
      config: cfg,
      profile: { turnMultiplier: 1, timeoutMultiplier: 1, allowSplit: true, maxRunMinutes: 0 },
    });
    manager.cancel(run.id);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "run.finished")).toBe(true));
    expect(manager.get(run.id)!.status).toBe("cancelled");
  });
});

describe("RunService resume edge cases", () => {
  it("refuses a missing run and a malformed journal without dispatching work", async () => {
    const cfg = config();
    const { channel, calls: seen } = fakeChannel(() => [text("x"), done()]);
    const fake = fakeHost({});
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
    const missing = await manager.resume("p", "nope", { config: cfg, channelFor: () => channel });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("run not found");
    fake.files["/tmp/st/scratch/run-bad/run.json"] = "{not json";
    const bad = await manager.resume("p", "run-bad", { config: cfg, channelFor: () => channel });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("resume unavailable");
    expect(seen).toHaveLength(0);
  });

  it("fails a replayed task whose role no longer resolves without calling the channel", async () => {
    const cfg = config();
    const { channel, calls: seen } = fakeChannel(() => [text("x"), done()]);
    const fake = fakeHost({});
    fake.files["/tmp/st/scratch/run-g/run.json"] = JSON.stringify({
      id: "run-g",
      projectId: "p",
      text: "go",
      status: "interrupted",
      startedAt: 1,
      tasks: [{ id: "t1", roleId: "ghost-role", title: "t", task: "t", files: [], dependsOn: [], status: "failed", error: "x", filesTouched: [] }],
    });
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus(() => {}, 0) });
    const res = await manager.resume("p", "run-g", { config: cfg, channelFor: () => channel });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(manager.get("run-g")?.status).toBe("failed"));
    expect(seen).toHaveLength(0);
    expect(manager.get("run-g")!.tasks?.[0]).toMatchObject({ status: "failed", summary: "no enabled role for 'ghost-role'" });
  });

  const interruptedJournal = (id: string) =>
    JSON.stringify({
      id,
      projectId: "p",
      text: "go",
      status: "interrupted",
      startedAt: 1,
      tasks: [{ id: "t1", roleId: "general-worker", title: "t", task: "t", files: [], dependsOn: [], status: "failed", error: "x", filesTouched: [] }],
    });

  it("confirmResume decline refuses before dispatch after emitting task.failed", async () => {
    const cfg = config();
    const { channel, calls: seen } = fakeChannel(() => [text("x"), done()]);
    const fake = fakeHost({});
    fake.files["/tmp/st/scratch/run-c/run.json"] = interruptedJournal("run-c");
    const events: RunEvent[] = [];
    const bus = new EventBus((e) => events.push(e), 0);
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
    bus.subscribe(async (e) => {
      if (e.kind === "ask_user") manager.answer(e.questionId, "Cancel");
    });
    const res = await manager.resume("p", "run-c", { config: cfg, channelFor: () => channel, confirmResume: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("resume declined by user");
    expect(seen).toHaveLength(0);
    expect(events.some((e) => e.kind === "task.failed")).toBe(true);
  });

  it("confirmResume accept replays the interrupted task", async () => {
    const cfg = config();
    let sent = 0;
    const { channel } = fakeChannel(() => (sent++, [text("resumed"), done()]));
    const fake = fakeHost({});
    fake.files["/tmp/st/scratch/run-r/run.json"] = interruptedJournal("run-r");
    const bus = new EventBus(() => {}, 0);
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
    bus.subscribe(async (e) => {
      if (e.kind === "ask_user") manager.answer(e.questionId, "Resume");
    });
    const res = await manager.resume("p", "run-r", { config: cfg, channelFor: () => channel, confirmResume: true });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(manager.get("run-r")?.status).toBe("done"));
    expect(sent).toBe(1);
  });
});

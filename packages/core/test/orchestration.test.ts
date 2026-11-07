import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "../src/channels/types.js";
import { ManagedChannel } from "../src/channels/registry.js";
import { EventBus } from "../src/events.js";
import { loadConfig, type Config } from "../src/config/loader.js";
import { counterIds, systemClock, type Clock } from "@stewart/kernel";
import { RunManager } from "../src/runManager.js";
import { DEFAULT_BUDGET_PROFILES, DEFAULT_LIMITS } from "@stewart/budget";
import { TaskGraph, LeaseManager } from "@stewart/scheduling";
import { isCosting } from "@stewart/models";
import { RunLedger, CostLimit, costOfCall } from "@stewart/ledger";
import { IdempotencyLog } from "../src/orchestration/idempotency.js";
import { freeCandidates, parseReplacements, rankDeterministic, validateReplacements } from "../src/orchestration/replacements.js";
import { leasedTools, LeaseCycleError, LeaseTimeoutError } from "../src/orchestration/writeGuard.js";
import { runRoleTask } from "../src/orchestration/roleRunner.js";
import { runOrchestrated } from "../src/orchestration/orchestrator.js";
import { orchestrationTools, type OrchestrationHandlers } from "../src/orchestration/tools.js";
import type { OrchestrationRuntime } from "../src/orchestration/types.js";
import { projectTools } from "../src/tools/builtins.js";
import { ProjectPaths } from "../src/tools/projectPaths.js";
import { ToolLoop } from "../src/tools/toolLoop.js";
import { ToolRegistry } from "../src/tools/types.js";
import { fakeHost } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";

const done = (usage?: { in: number; out: number }, costUsd?: number): ChatEvent => ({ kind: "done", usage, costUsd });
const text = (t: string): ChatEvent => ({ kind: "text", text: t });
const calls = (...c: { id: string; name: string; arguments: Record<string, unknown> }[]): ChatEvent => ({ kind: "tool_calls", calls: c });

type Script = (role: string, call: number, req: ChatRequest) => ChatEvent[];

function fakeChannel(script: Script, opts: { maxParallel?: number } = {}): { channel: ManagedChannel; calls: string[] } {
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
  const cfg = { id: "c1", type: "fake", enabled: true, maxParallel: opts.maxParallel ?? 4, modelCaps: { m: { tools: "native" as const } } };
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
  - id: a-priced
    channel: c1
    model: m
    billing: priced
    price: { inPerMTok: 3, outPerMTok: 15 }
`;

function rolesYaml(over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    orchestrator: "enabled: true\n    agent: a-paid\n    tools: [dispatch, ask_user, ReadFile, FindFiles]",
    "general-worker": "enabled: true\n    agent: a-free",
    "code-writer": "enabled: true\n    agent: a-paid\n    tools: [WriteFile, ReadFile, dispatch]",
    investigator: "enabled: true\n    agent: a-free\n    tools: [ReadFile]",
    planner: "enabled: true\n    agent: a-free\n    tools: [submit_plan]",
    "plan-validator": "enabled: true\n    agent: a-free\n    tools: [submit_verdict]",
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
): Promise<{ rt: OrchestrationRuntime; events: RunEvent[]; files: Record<string, string>; host: ReturnType<typeof fakeHost>["host"] }> {
  const fake = fakeHost(over.files ?? { "a.ts": "a", "b.ts": "b" });
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
    ask: async () => "Stop",
    approve: async () => ({ kind: "approved" }),
    ...over,
  };
  return { rt, events, files: fake.files, host: fake.host };
}

describe("TaskGraph", () => {
  it("rejects duplicate ids", () => {
    const g = new TaskGraph();
    g.add({ id: "t1", roleId: "r", title: "t", task: "x", files: [], dependsOn: [] });
    expect(() => g.add({ id: "t1", roleId: "r", title: "t", task: "x", files: [], dependsOn: [] })).toThrow(/duplicate/);
  });

  it("reports unknown dependencies and cycles", () => {
    const g = new TaskGraph();
    g.add({ id: "a", roleId: "r", title: "a", task: "x", files: [], dependsOn: ["missing"] });
    expect(g.validate()).toEqual(["task a: unknown dependsOn 'missing'"]);
    const c = new TaskGraph();
    c.add({ id: "a", roleId: "r", title: "a", task: "x", files: [], dependsOn: ["b"] });
    c.add({ id: "b", roleId: "r", title: "b", task: "x", files: [], dependsOn: ["a"] });
    expect(c.validate()[0]).toMatch(/cycle/);
  });

  it("readies only tasks whose dependencies are done", () => {
    const g = new TaskGraph();
    g.add({ id: "a", roleId: "r", title: "a", task: "x", files: [], dependsOn: [] });
    g.add({ id: "b", roleId: "r", title: "b", task: "x", files: [], dependsOn: ["a"] });
    expect(g.ready().map((t) => t.id)).toEqual(["a"]);
    g.get("a")!.status = "done";
    expect(g.ready().map((t) => t.id)).toEqual(["b"]);
  });

  it("blocks dependents of failed tasks and reports finished", () => {
    const g = new TaskGraph();
    g.add({ id: "a", roleId: "r", title: "a", task: "x", files: [], dependsOn: [] });
    g.add({ id: "b", roleId: "r", title: "b", task: "x", files: [], dependsOn: ["a"] });
    g.get("a")!.status = "failed";
    expect(g.blockedByFailure().map((t) => t.id)).toEqual(["b"]);
    expect(g.finished).toBe(false);
    g.get("b")!.status = "stopped";
    expect(g.finished).toBe(true);
  });
});

describe("LeaseManager", () => {
  it("grants disjoint paths to different tasks", async () => {
    const l = new LeaseManager();
    expect(await l.acquire("a", "t1", 10)).toEqual({ kind: "granted" });
    expect(await l.acquire("b", "t2", 10)).toEqual({ kind: "granted" });
    expect(l.heldBy("t1")).toEqual(["a"]);
  });

  it("serialises the same path and grants on release", async () => {
    const l = new LeaseManager();
    await l.acquire("a", "t1", 10);
    let waited = "";
    const p = l.acquire("a", "t2", 1000, (holder) => (waited = holder));
    expect(waited).toBe("t1");
    l.release("t1");
    expect(await p).toEqual({ kind: "granted" });
    expect(l.holder("a")).toBe("t2");
  });

  it("times out instead of failing when the holder never releases", async () => {
    const l = new LeaseManager();
    await l.acquire("a", "t1", 10);
    expect(await l.acquire("a", "t2", 10)).toEqual({ kind: "timeout" });
  });

  it("detects an AB-BA cycle and picks the younger task as victim", async () => {
    const l = new LeaseManager();
    l.register("old");
    l.register("young");
    await l.acquire("a", "old", 10);
    await l.acquire("b", "young", 10);
    void l.acquire("b", "old", 5000);
    const res = await l.acquire("a", "young", 5000);
    expect(res).toEqual({ kind: "cycle", victim: "young" });
  });

  it("releaseAll resolves waiters as timeouts", async () => {
    const l = new LeaseManager();
    await l.acquire("a", "t1", 10);
    const p = l.acquire("a", "t2", 5000);
    l.releaseAll();
    expect(await p).toEqual({ kind: "timeout" });
  });
});

describe("RunLedger", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    runId: "run-1",
    taskId: "t1",
    roleId: "code-writer",
    agentId: "a-paid",
    model: "m",
    billing: "reported",
    inTokens: 100,
    outTokens: 50,
    costUsd: 0.02,
    ...over,
  });

  it("survives a restart by replaying the append-only file", async () => {
    const { host, files } = fakeHost();
    const first = new RunLedger(host, "/tmp/st/ledger.jsonl", systemClock);
    await first.record(entry());
    await first.record(entry({ roleId: "tester", costUsd: 0.03 }));
    const second = new RunLedger(host, "/tmp/st/ledger.jsonl", systemClock);
    await second.load();
    const c = second.cost("run-1");
    expect(c.costUsd).toBeCloseTo(0.05);
    expect(c.byRole).toEqual({ "code-writer": 0.02, tester: 0.03 });
    expect(c.byAgent["a-paid"]).toEqual({ costUsd: 0.05, inTokens: 200, outTokens: 100 });
    expect(files["/tmp/st/ledger.jsonl"].split("\n")).toHaveLength(2);
  });

  it("skips a torn tail line", async () => {
    const { host } = fakeHost({ "/tmp/st/ledger.jsonl": `${JSON.stringify(entry())}\n{"runId":"run-` });
    const l = new RunLedger(host, "/tmp/st/ledger.jsonl", systemClock);
    await l.load();
    expect(l.cost("run-1").costUsd).toBeCloseTo(0.02);
  });

  it("keeps runs separate", async () => {
    const { host } = fakeHost();
    const l = new RunLedger(host, "/tmp/st/ledger.jsonl", systemClock);
    await l.record(entry());
    await l.record(entry({ runId: "run-2", costUsd: 1 }));
    expect(l.cost("run-2").costUsd).toBe(1);
    expect(l.cost("run-1").costUsd).toBeCloseTo(0.02);
  });
});

describe("costOfCall", () => {
  it("is zero for free and unmetered agents", () => {
    expect(costOfCall({ billing: "free" }, { in: 1e6, out: 1e6 }, 5)).toBe(0);
    expect(isCosting({ billing: "unmetered" })).toBe(false);
  });

  it("computes priced cost from tokens and keeps reported cost otherwise", () => {
    expect(costOfCall({ billing: "priced", price: { inPerMTok: 3, outPerMTok: 15 } }, { in: 1e6, out: 1e6 }, 99)).toBeCloseTo(18);
    expect(costOfCall({ billing: "reported" }, { in: 1, out: 1 }, 0.42)).toBeCloseTo(0.42);
    expect(costOfCall({ billing: "reported" }, undefined, undefined)).toBe(0);
  });
});

describe("CostLimit", () => {
  it("never trips when disabled", () => {
    const c = new CostLimit(0, "ask", 10);
    expect(c.enabled).toBe(false);
    expect(c.reached()).toBe(false);
  });

  it("trips at the cap and raises by perRunUsd", () => {
    const c = new CostLimit(1, "ask", 0.6);
    expect(c.reached()).toBe(false);
    c.accrued = 1.2;
    expect(c.reached()).toBe(true);
    expect(c.overshoot()).toBeCloseTo(0.2);
    expect(c.raise()).toBe(2);
    expect(c.reached()).toBe(false);
  });
});

describe("IdempotencyLog", () => {
  it("persists outcomes and reloads them", async () => {
    const { host } = fakeHost();
    const a = new IdempotencyLog(host, "/tmp/st/scratch/run-1/executed.jsonl", "run-1");
    await a.record("run-1:t1:0", "wrote a.ts");
    const b = new IdempotencyLog(host, "/tmp/st/scratch/run-1/executed.jsonl", "run-1");
    await b.load();
    expect(b.get("run-1:t1:0")).toBe("wrote a.ts");
    expect(b.size).toBe(1);
  });

  it("keys by run, task and call index", async () => {
    const { host } = fakeHost();
    const log = new IdempotencyLog(host, "/tmp/st/x.jsonl", "run-9");
    const hooks = log.hooks("task-3");
    const key = hooks.key({ id: "c1", name: "WriteFile", arguments: {} }, 2);
    expect(key).toBe("run-9:task-3:2");
    await hooks.record(key, "ok");
    expect(hooks.lookup(key)).toBe("ok");
  });

  it("a resumed tool loop replays the recorded outcome instead of re-executing", async () => {
    const { host, files } = fakeHost({ "a.ts": "one" });
    const paths = await ProjectPaths.forProject(host);
    const { channel } = fakeChannel((_r, n) =>
      n === 1 ? [calls({ id: "c1", name: "WriteFile", arguments: { path: "a.ts", content: "two" } }), done()] : [text("done"), done()],
    );
    const log = new IdempotencyLog(host, "/tmp/st/scratch/run-1/executed.jsonl", "run-1");
    await log.record("run-1:t1:0", "wrote a.ts (1 lines)");
    const loop = new ToolLoop(
      channel,
      new ToolRegistry(projectTools(host, paths).tools),
      async () => ({ kind: "approved" }),
      undefined,
      systemClock,
      undefined,
      new Set(),
      "native",
      log.hooks("t1"),
    );
    const res = await loop.run("m", [{ role: "user", content: "go" }], {}, new AbortController().signal);
    expect(res.kind).toBe("completed");
    expect(files["a.ts"]).toBe("one");
  });
});

describe("replacements", () => {
  const agents = [
    { id: "free-small", channel: "c1", model: "small", billing: "free" },
    { id: "free-big", channel: "c1", model: "big", billing: "free" },
    { id: "paid", channel: "c1", model: "big", billing: "reported" },
    { id: "free-no-vision", channel: "c1", model: "small", billing: "free" },
  ] as never;
  const channels = [
    { id: "c1", type: "fake", enabled: true, modelCaps: { small: { contextTokens: 8000 }, big: { contextTokens: 200000 }, vision: {} } },
  ] as never;

  it("filters to enabled free agents that can serve the role", () => {
    const out = freeCandidates([{ roleId: "code-writer" }, { roleId: "image-reader" }], agents, channels);
    expect(out["code-writer"].map((a) => a.id).sort()).toEqual(["free-big", "free-no-vision", "free-small"]);
    expect(out["image-reader"]).toEqual([]);
  });

  it("ranks deterministically by context size then id", () => {
    const ranked = rankDeterministic({ "code-writer": freeCandidates([{ roleId: "code-writer" }], agents, channels)["code-writer"] }, channels);
    expect(ranked).toEqual([{ role: "code-writer", agent: "free-big", reason: expect.stringContaining("deterministic") }]);
  });

  it("rejects invented replacements", () => {
    const cands = freeCandidates([{ roleId: "code-writer" }], agents, channels);
    const valid = validateReplacements([{ role: "code-writer", agent: "free-small", reason: "x" }], cands);
    const invented = validateReplacements([{ role: "code-writer", agent: "ghost", reason: "x" }], cands);
    expect(valid).toHaveLength(1);
    expect(invented).toHaveLength(0);
  });

  it("parses malformed model output defensively", () => {
    expect(parseReplacements(undefined)).toEqual([]);
    expect(parseReplacements({ replacements: [{ role: 1 }, { role: "r", agent: "a" }] })).toEqual([{ role: "r", agent: "a", reason: "" }]);
  });
});

describe("writeGuard", () => {
  const tools = async (files: Record<string, string> = { "a.ts": "a" }) => {
    const fake = fakeHost(files);
    const paths = await ProjectPaths.forProject(fake.host);
    return { ...fake, paths, tools: projectTools(fake.host, paths).tools };
  };

  it("leases a path before writing and snapshots the pre-image once", async () => {
    const { host, tools: all, files } = await tools();
    const leases = new LeaseManager();
    const wrapped = leasedTools(all, { host, leases, taskId: "t1", runId: "run-1", leaseWaitMs: 50, stateDir: "/tmp/st" });
    const write = wrapped.find((t) => t.spec.name === "WriteFile")!;
    const preview = await write.preview!({ path: "a.ts", content: "b" });
    await write.execute({ path: "a.ts", content: "b" }, preview, new AbortController().signal);
    expect(files["a.ts"]).toBe("b");
    expect(leases.holder("a.ts")).toBe("t1");
    expect(files["/tmp/st/scratch/run-1/snapshots/a.ts"]).toBe("a");
  });

  it("leaves read tools untouched", async () => {
    const { host, tools: all } = await tools();
    const wrapped = leasedTools(all, { host, leases: new LeaseManager(), taskId: "t1", runId: "run-1", leaseWaitMs: 50, stateDir: "/tmp/st" });
    const read = wrapped.find((t) => t.spec.name === "ReadFile")!;
    expect(read).toBe(all.find((t) => t.spec.name === "ReadFile"));
  });

  it("times out and reports a lease fault", async () => {
    const { host, tools: all } = await tools();
    const leases = new LeaseManager();
    await leases.acquire("a.ts", "other", 10);
    const write = leasedTools(all, { host, leases, taskId: "t1", runId: "run-1", leaseWaitMs: 10, stateDir: "/tmp/st" }).find(
      (t) => t.spec.name === "WriteFile",
    )!;
    await expect(write.execute({ path: "a.ts", content: "b" }, null, new AbortController().signal)).rejects.toBeInstanceOf(LeaseTimeoutError);
  });

  it("aborts a write that closes a lease cycle", async () => {
    const { host, tools: all } = await tools();
    const leases = new LeaseManager();
    leases.register("t1");
    leases.register("t2");
    await leases.acquire("a.ts", "t1", 10);
    await leases.acquire("b.ts", "t2", 10);
    const w1 = leasedTools(all, { host, leases, taskId: "t1", runId: "run-1", leaseWaitMs: 5000, stateDir: "/tmp/st" }).find(
      (t) => t.spec.name === "WriteFile",
    )!;
    const w2 = leasedTools(all, { host, leases, taskId: "t2", runId: "run-1", leaseWaitMs: 5000, stateDir: "/tmp/st" }).find(
      (t) => t.spec.name === "WriteFile",
    )!;
    void w1.execute({ path: "b.ts", content: "x" }, null, new AbortController().signal);
    await expect(w2.execute({ path: "a.ts", content: "y" }, null, new AbortController().signal)).rejects.toBeInstanceOf(LeaseCycleError);
  });
});

const verbs = (over: Partial<OrchestrationHandlers> = {}) =>
  orchestrationTools({
    dispatch: async () => "{}",
    askUser: async () => "",
    submitPlan: () => "Plan recorded with 2 milestone(s).",
    submitVerdict: () => "Verdict recorded: approved. Proceed with implementation dispatches.",
    submitReplacements: () => "none",
    ...over,
  });

describe("runRoleTask", () => {
  const role = (id: string) => config().roles.find((r) => r.id === id)!;

  it("fails when the role has no agent bound", async () => {
    const cfg = config({ roles: { investigator: "enabled: true\n    agent: gone\n    tools: [ReadFile]" } });
    const { channel } = fakeChannel(() => [text("x"), done()]);
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "investigator", title: "t", task: "look", files: [], dependsOn: [] }, {
      role: cfg.roles.find((r) => r.id === "investigator")!,
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("no agent bound");
  });

  it("returns the assistant text as the summary and records ledger cost", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("found it"), done({ in: 1000, out: 500 }, 0.02)]);
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "code-writer", title: "t", task: "look", files: [], dependsOn: [] }, {
      role: role("code-writer"),
    });
    expect(res.status).toBe("done");
    expect(res.summary).toBe("found it");
    expect(rt.cost.accrued).toBeCloseTo(0.02);
    expect(rt.ledger.cost("run-1").byRole["code-writer"]).toBeCloseTo(0.02);
  });

  it("keeps the task unresolved until the ledger append is durable", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("wrote"), done({ in: 1000, out: 500 }, 0.02)]);
    const { rt, host } = await runtime(cfg, channel);
    const orig = host.files.appendLine;
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    let appends = 0;
    host.files.appendLine = async (p, line) => {
      if (p.endsWith("ledger.jsonl")) {
        appends++;
        await gate;
      }
      return orig(p, line);
    };
    let settled = false;
    const task = runRoleTask(rt, { id: "t1", roleId: "code-writer", title: "t", task: "x", files: [], dependsOn: [] }, {
      role: role("code-writer"),
    }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(appends).toBe(1);
    expect(settled).toBe(false);
    release();
    expect((await task).status).toBe("done");
    expect(rt.ledger.cost("run-1").costUsd).toBeCloseTo(0.02);
  });

  it("fails the task and records no cost when the ledger append rejects", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("wrote"), done({ in: 1000, out: 500 }, 0.02)]);
    const { rt, host } = await runtime(cfg, channel);
    const orig = host.files.appendLine;
    host.files.appendLine = async (p, line) => {
      if (p.endsWith("ledger.jsonl")) throw new Error("fsync failed");
      return orig(p, line);
    };
    const res = await runRoleTask(rt, { id: "t1", roleId: "code-writer", title: "t", task: "x", files: [], dependsOn: [] }, {
      role: role("code-writer"),
    });
    expect(res.status).toBe("failed");
    expect(res.summary).toContain("fsync failed");
    expect(rt.ledger.cost("run-1").costUsd).toBe(0);
    expect(rt.cost.accrued).toBe(0);
  });

  it("prefers a terminal tool result over prose", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [
      calls({ id: "c1", name: "submit_verdict", arguments: { verdict: "approve", reasons: ["ok"] } }),
      done(),
    ]);
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "plan-validator", title: "t", task: "judge", files: [], dependsOn: [] }, {
      role: role("plan-validator"),
      nestedTools: verbs(),
    });
    expect(res.status).toBe("done");
    expect(res.summary).toContain("Verdict recorded: approved");
  });

  it("parks a costing task at the cap and keeps free work running", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("x"), done()]);
    const { rt } = await runtime(cfg, channel, { cost: new CostLimit(1, "ask", 2) });
    const paid = await runRoleTask(rt, { id: "t1", roleId: "code-writer", title: "t", task: "x", files: [], dependsOn: [] }, {
      role: role("code-writer"),
    });
    const free = await runRoleTask(rt, { id: "t2", roleId: "investigator", title: "t", task: "x", files: [], dependsOn: [] }, {
      role: role("investigator"),
    });
    expect(paid.status).toBe("parked");
    expect(free.status).toBe("done");
  });

  it("stops at the role turn budget", async () => {
    const cfg = config({ roles: { investigator: "enabled: true\n    agent: a-free\n    tools: [ReadFile]\n    turnBudget: 1" } });
    const { channel } = fakeChannel(() => [calls({ id: "c1", name: "ReadFile", arguments: { path: "a.ts" } }), done()]);
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "investigator", title: "t", task: "x", files: [], dependsOn: [] }, {
      role: cfg.roles.find((r) => r.id === "investigator")!,
    });
    expect(res.status).toBe("stopped");
    expect(res.summary).toContain("turn limit");
  });

  it("fails over to fallbackAgent when primary channel is unhealthy and prompts on free->paid switch", async () => {
    const cfg = config({
      roles: {
        investigator: "enabled: true\n    agent: a-free\n    fallbackAgent: a-paid\n    tools: [ReadFile]",
      },
    });
    const unhealthy = fakeChannel(() => [text("bad"), done()]).channel;
    unhealthy.unhealthy = true;
    const healthy = fakeChannel(() => [text("from-fallback"), done()]).channel;
    const { rt: rtDeclined } = await runtime(cfg, healthy, {
      channelFor: (id) => (id === "c1" ? unhealthy : healthy),
      ask: async () => "Park",
    });
    cfg.agents.find((a) => a.id === "a-paid")!.channel = "c2";
    cfg.channels.push({ id: "c2", type: "fake", enabled: true, discoverModels: true, extraModels: [], modelCaps: { m: { tools: "native" } } });
    const declined = await runRoleTask(
      rtDeclined,
      { id: "t1", roleId: "investigator", title: "t", task: "x", files: [], dependsOn: [] },
      { role: cfg.roles.find((r) => r.id === "investigator")! },
    );
    expect(declined.status).toBe("parked");
    expect(declined.summary).toContain("declined");

    const { rt: rtSwitched } = await runtime(cfg, healthy, {
      channelFor: (id) => (id === "c1" ? unhealthy : healthy),
      ask: async () => "Switch",
    });
    const switched = await runRoleTask(
      rtSwitched,
      { id: "t2", roleId: "investigator", title: "t", task: "x", files: [], dependsOn: [] },
      { role: cfg.roles.find((r) => r.id === "investigator")! },
    );
    expect(switched.status).toBe("done");
    expect(switched.summary).toBe("from-fallback");
  });
});

describe("runOrchestrated", () => {
  let callSeq = 0;
  const plan = (role: string, task: string, extra: Record<string, unknown> = {}) => ({
    id: `call-${++callSeq}`,
    name: "dispatch",
    arguments: { role, task, ...extra },
  });

  it("fails when the orchestrator role is disabled", async () => {
    const cfg = config({ roles: { orchestrator: "enabled: false\n    agent: a-paid" } });
    const { channel } = fakeChannel(() => [text("x"), done()]);
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("failed");
    expect(out.error).toContain("orchestrator role is not enabled");
  });

  it("fails when the orchestrator has no agent bound", async () => {
    const cfg = config({ roles: { orchestrator: "enabled: true\n    agent: gone" } });
    const { channel } = fakeChannel(() => [text("x"), done()]);
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("failed");
    expect(out.error).toContain("no agent bound");
  });

  it("limits an orchestrator with no listed tools to routing tools", async () => {
    const cfg = config({ roles: { orchestrator: "enabled: true\n    agent: a-paid\n    tools: []" } });
    let names: string[] = [];
    const { channel } = fakeChannel((_r, _n, req) => {
      names = (req.tools ?? []).map((t) => t.name);
      return [text("x"), done()];
    });
    const { rt } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(names).toContain("dispatch");
    expect(names).not.toContain("WriteFile");
    expect(names).not.toContain("ReadFile");
  });

  it("keeps explicitly listed project tools for the orchestrator", async () => {
    const cfg = config();
    let names: string[] = [];
    const { channel } = fakeChannel((_r, _n, req) => {
      names = (req.tools ?? []).map((t) => t.name);
      return [text("x"), done()];
    });
    const { rt } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(names).toContain("ReadFile");
    expect(names).not.toContain("WriteFile");
  });

  it("fails the run and records no cost when the ledger append rejects", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("hi"), done({ in: 1000, out: 500 }, 0.05)]);
    const { rt, host } = await runtime(cfg, channel);
    const orig = host.files.appendLine;
    host.files.appendLine = async (p, line) => {
      if (p.endsWith("ledger.jsonl")) throw new Error("fsync failed");
      return orig(p, line);
    };
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("failed");
    expect(out.error).toContain("fsync failed");
    expect(rt.ledger.cost("run-1").costUsd).toBe(0);
    expect(rt.cost.accrued).toBe(0);
  });

  it("dispatches to a role and answers with the routed result", async () => {
    const cfg = config();
    const { channel, calls: seen } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "write a.ts")), done()] : [text("all done"), done()];
      return [text("wrote a.ts"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "write a.ts");
    expect(out.status).toBe("done");
    expect(seen).toEqual(["orchestrator#1", "code-writer#1", "orchestrator#2"]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("task.created");
    expect(kinds).toContain("task.started");
    expect(events.find((e) => e.kind === "task.started")).toMatchObject({ roleId: "code-writer", agentId: expect.any(String) });
    expect(kinds).toContain("task.done");
    expect(events.find((e) => e.kind === "task.done")).toMatchObject({ roleId: "code-writer" });
  });

  it("runs independent dispatches in parallel", async () => {
    const cfg = config();
    let live = 0;
    let peak = 0;
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "one"), plan("investigator", "two")), done()] : [text("done"), done()];
      return [text(role), done()];
    });
    const { rt } = await runtime(cfg, channel);
    const original = rt.channelFor("c1");
    const spy = new ManagedChannel(
      {
        type: "spy",
        listModels: async () => [],
        probeCaps: async () => ({}),
        async *chat(c, s, req) {
          const sys = req.messages[0]?.role === "system" ? (req.messages[0] as { content: string }).content : "";
          if (!sys.includes("ROLE:orchestrator")) {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 20));
            live--;
          }
          yield* original.adapter.chat(c, s, req);
        },
      },
      { id: "c1", type: "spy", enabled: true, maxParallel: 4, modelCaps: { m: { tools: "native" } } },
    );
    rt.channelFor = () => spy;
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    expect(peak).toBe(2);
  });

  it("honours dependsOn and rejects unknown dependencies", async () => {
    const cfg = config();
    let firstId = "";
    const { channel } = fakeChannel((role, n, req) => {
      if (role !== "orchestrator") return [text("ok"), done()];
      if (n === 1) return [calls(plan("investigator", "look")), done()];
      if (n === 2) {
        const tool = [...req.messages].reverse().find((m) => m.role === "tool") as { content: string } | undefined;
        firstId = JSON.parse(tool!.content).taskId;
        return [calls(plan("code-writer", "write", { dependsOn: [firstId] }), plan("code-writer", "bad", { dependsOn: ["ghost"] })), done()];
      }
      return [text("done"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    const bad = events.find((e) => e.kind === "task.failed");
    expect(bad).toMatchObject({ error: expect.stringContaining("unknown dependsOn") });
    const dependent = events.filter((e) => e.kind === "task.done");
    expect(dependent).toHaveLength(2);
  });

  it("rejects a disabled role with an error tool-result listing valid role ids", async () => {
    const cfg = config({ roles: { "code-writer": "enabled: false\n    agent: a-paid" } });
    let toolResult = "";
    const { channel } = fakeChannel((role, n, req) => {
      if (role !== "orchestrator") return [text("ok"), done()];
      if (n === 1) return [calls(plan("code-writer", "x")), done()];
      toolResult = [...req.messages].reverse().find((m) => m.role === "tool")?.content as string;
      return [text("done"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(JSON.parse(toolResult)).toMatchObject({ status: "rejected", error: expect.stringContaining("Valid role ids:") });
    const validList = JSON.parse(toolResult).error.split("Valid role ids: ")[1];
    expect(validList).toContain("general-worker");
    expect(validList).not.toContain("code-writer");
    expect(events.some((e) => e.kind === "task.created")).toBe(false);
    expect(out.status).toBe("no_dispatch");
  });

  it("falls back to General Worker only when the role is blank", async () => {
    const cfg = config();
    // The schema requires the key, so a blank string is the only way a model reaches the fallback.
    const omitted = { id: "call-omit", name: "dispatch", arguments: { role: "  ", task: "x" } };
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? (n === 1 ? [calls(omitted), done()] : [text("done"), done()]) : [text("ok"), done()]));
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(events.find((e) => e.kind === "task.created")).toMatchObject({ roleId: "general-worker" });
    expect(out.status).toBe("done");
  });

  it("flags a run whose Orchestrator never dispatches and keeps its last reply in the warning", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("Here is the answer"), done()]);
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("no_dispatch");
    expect(out.error).toContain("finished without dispatching any tasks");
    expect(out.error).toContain("Last reply: Here is the answer");
    expect(events.some((e) => e.kind === "task.created")).toBe(false);
  });

  it("retries once with a format nudge when the reply holds an unparsed tool call", async () => {
    const cfg = config();
    let n = 0;
    const { channel } = fakeChannel((role) => (role === "orchestrator" && ++n === 1 ? [text("x <tool_call name=\"dispatch\" bad"), done()] : [text("Here is the answer"), done()]));
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(n).toBe(2);
    expect(out.status).toBe("no_dispatch");
  });

  it("does not retry a plain direct answer", async () => {
    const cfg = config();
    let n = 0;
    const { channel } = fakeChannel((role) => (role === "orchestrator" && ++n ? [text("Here is the answer"), done()] : [text("ok"), done()]));
    const { rt } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(n).toBe(1);
  });

  it("fails a dispatch when no role and no fallback is enabled", async () => {
    const cfg = config({ roles: { "code-writer": "enabled: false\n    agent: a-paid", "general-worker": "enabled: false\n    agent: a-free" } });
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? (n === 1 ? [calls(plan("code-writer", "x")), done()] : [text("done"), done()]) : [text("ok"), done()]));
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("no_dispatch");
    expect(events.some((e) => e.kind === "task.created")).toBe(false);
  });

  it("runs the plan/validate/approve flow", async () => {
    const cfg = config();
    const { channel } = fakeChannel((role, n) => {
      if (role === "planner") return [calls({ id: "p", name: "submit_plan", arguments: { milestones: [{ title: "m1" }, { title: "m2" }] } }), done()];
      if (role === "plan-validator") return [calls({ id: "v", name: "submit_verdict", arguments: { verdict: "approve" } }), done()];
      if (n === 1) return [calls(plan("planner", "make a plan")), done()];
      if (n === 2) return [calls(plan("plan-validator", "check the plan")), done()];
      return [text("implemented"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    expect(events.find((e) => e.kind === "plan.created")).toMatchObject({ milestoneCount: 2 });
    expect(events.find((e) => e.kind === "plan.validated")).toMatchObject({ verdict: "approve" });
    expect(events.find((e) => e.kind === "plan.approved")).toMatchObject({ milestoneCount: 2 });
  });

  it("replans on a revise verdict and stops at maxReplans", async () => {
    const cfg = config({ settings: "version: 1\nmaxReplans: 1\n" });
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "plan-validator") return [calls({ id: `v${n}`, name: "submit_verdict", arguments: { verdict: "revise", reasons: ["missing tests"] } }), done()];
      if (n === 1) return [calls(plan("plan-validator", "check")), done()];
      if (n === 2) return [calls(plan("plan-validator", "check again")), done()];
      const tool = [...req.messages].reverse().find((m) => m.role === "tool") as { content: string };
      return [text(tool.content), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    expect(events.filter((e) => e.kind === "plan.validated")).toHaveLength(2);
    expect(events.some((e) => e.kind === "plan.approved")).toBe(false);
  });

  it("gates an approved plan on the user when planGate is on", async () => {
    const cfg = config({ settings: "version: 1\nplanGate: true\n" });
    const asked: string[] = [];
    const mk = () =>
      fakeChannel((role, n) => {
        if (role === "plan-validator") return [calls({ id: "v", name: "submit_verdict", arguments: { verdict: "approve" } }), done()];
        if (n === 1) return [calls(plan("plan-validator", "check")), done()];
        return [text("done"), done()];
      }).channel;
    const first = await runtime(cfg, mk(), {
      ask: async (q) => {
        asked.push(q);
        return "Revise";
      },
    });
    await runOrchestrated(first.rt, "go");
    expect(asked[0]).toContain("Plan approved by the validator");
    expect(first.events.some((e) => e.kind === "plan.approved")).toBe(false);

    const second = await runtime(cfg, mk(), { ask: async () => "Proceed" });
    await runOrchestrated(second.rt, "go");
    expect(second.events.some((e) => e.kind === "plan.approved")).toBe(true);
  });

  it("parks costing work at the cap, keeps free work, and raises the cap on Continue", async () => {
    const cfg = config({ settings: "version: 1\ncostLimit:\n  perRunUsd: 0.01\n  onLimit: ask\n" });
    let firstId = "";
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "code-writer") return [text("wrote"), done({ in: 1000, out: 1000 }, 0.05)];
      if (role === "investigator") return [text("looked"), done()];
      if (n === 1) return [calls(plan("code-writer", "write")), done()];
      if (n === 2) {
        const tool = [...req.messages].reverse().find((m) => m.role === "tool") as { content: string };
        firstId = JSON.parse(tool.content).taskId;
        return [calls(plan("code-writer", "write more", { dependsOn: [firstId] }), plan("investigator", "look")), done()];
      }
      return [text("done"), done()];
    });
    const asked: string[] = [];
    const { rt, events } = await runtime(cfg, channel, {
      ask: async (q, opts) => {
        asked.push(`${q} | ${(opts ?? []).join(",")}`);
        return "Continue (+cost cap)";
      },
    });
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    expect(asked[0]).toContain("Cost limit reached");
    expect(asked[0]).toContain("Continue (+cost cap)");
    const summary = events.find((e) => e.kind === "cost.summary") as Extract<RunEvent, { kind: "cost.summary" }>;
    expect(summary.parked).toHaveLength(1);
    expect(summary.freeFinished).toHaveLength(1);
    expect(summary.byRole["code-writer"]).toBeCloseTo(0.05);
    expect(events.find((e) => e.kind === "cost.limit_raised")).toMatchObject({ capUsd: 0.02 });
  });

  it("stops parked work at the cap and keeps free results when the user stops", async () => {
    const cfg = config({ settings: "version: 1\ncostLimit:\n  perRunUsd: 0.01\n  onLimit: ask\n" });
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "write")), done()] : [text("done"), done()];
      if (role === "code-writer") return [text("wrote"), done({ in: 1000, out: 1000 }, 0.05)];
      return [text("looked"), done()];
    });
    const { rt, events } = await runtime(cfg, channel, { ask: async () => "Stop" });
    await runOrchestrated(rt, "go");
    expect(events.some((e) => e.kind === "cost.limit_raised")).toBe(false);
    expect(events.some((e) => e.kind === "cost.summary")).toBe(true);
  });

  it("never parks work when the cost limit is off", async () => {
    const cfg = config();
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "write")), done()] : [text("done"), done()];
      return [text("wrote"), done({ in: 1000, out: 1000 }, 5)];
    });
    const { rt, events } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(events.some((e) => e.kind === "cost.summary")).toBe(false);
    expect(events.find((e) => e.kind === "task.done")).toBeDefined();
  });

  it("accepts valid replacements and drops invented ones", async () => {
    const cfg = config({ settings: "version: 1\ncostLimit:\n  perRunUsd: 0.01\n  onLimit: ask\n" });
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "write")), done()] : [text("done"), done()];
      return [text("wrote"), done({ in: 1000, out: 1000 }, 0.05)];
    });
    const { rt, events } = await runtime(cfg, channel, { ask: async () => "Stop" });
    await runOrchestrated(rt, "go");
    const summary = events.find((e) => e.kind === "cost.summary") as Extract<RunEvent, { kind: "cost.summary" }>;
    expect(summary.suggestions.every((s) => s.agent !== "ghost")).toBe(true);
  });

  it("lets a write role dispatch one level deep and enforces the nested budget", async () => {
    const cfg = config({ settings: "version: 1\nmaxNestedDispatches: 1\n" });
    const { channel, calls: seen } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "write")), done()] : [text("done"), done()];
      if (role === "code-writer") {
        if (n === 1) return [calls({ id: "n1", name: "dispatch", arguments: { role: "investigator", task: "look" } }), done()];
        if (n === 2) return [calls({ id: "n2", name: "dispatch", arguments: { role: "investigator", task: "look again" } }), done()];
        return [text("wrote it"), done()];
      }
      return [text("found"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    expect(seen).toEqual(["orchestrator#1", "code-writer#1", "investigator#1", "code-writer#2", "code-writer#3", "orchestrator#2"]);
    const investigatorTasks = events.filter((e) => e.kind === "task.created" && e.roleId === "investigator");
    expect(investigatorTasks).toHaveLength(1);
    const codeWriterOutcomes = events.filter((e) => e.kind === "tool.outcome" && e.roleId === "code-writer");
    expect(codeWriterOutcomes).toHaveLength(2);
  });

  it("blocks write-role dispatches before plan approval when planGate is true", async () => {
    const cfg = config({ settings: "version: 1\nplanGate: true\n" });
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") return n === 1 ? [calls(plan("code-writer", "write early")), done()] : [text("blocked"), done()];
      return [text("wrote"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    const failed = events.find((e) => e.kind === "task.failed") as Extract<RunEvent, { kind: "task.failed" }>;
    expect(failed.error).toContain("plan gate active");
  });

  it("routes nested ask_user through the Orchestrator first and delegates only when needed", async () => {
    const cfg = config({
      roles: {
        "code-writer": "enabled: true\n    agent: a-free\n    tools: [ask_user, WriteFile]",
      },
    });
    let uiAsked = 0;
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "orchestrator") {
        const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        if (lastUser.includes("Role 'code-writer' asks: Which file?")) return [text("Use a.ts"), done()];
        if (lastUser.includes("Role 'code-writer' asks: Secret key?")) return [text("DELEGATE_TO_USER"), done()];
        return n === 1 ? [calls(plan("code-writer", "implement")), done()] : [text("done"), done()];
      }
      if (role === "code-writer") {
        if (n === 1) return [calls({ id: "q1", name: "ask_user", arguments: { question: "Which file?" } }), done()];
        if (n === 2) return [calls({ id: "q2", name: "ask_user", arguments: { question: "Secret key?" } }), done()];
        return [text("implemented"), done()];
      }
      return [text("ok"), done()];
    });
    const { rt, events } = await runtime(cfg, channel, {
      ask: async () => {
        uiAsked++;
        return "user-secret";
      },
    });
    const out = await runOrchestrated(rt, "update a.ts");
    expect(out.status).toBe("done");
    expect(uiAsked).toBe(1);
    const answered = events.filter((e) => e.kind === "question.answered") as Extract<RunEvent, { kind: "question.answered" }>[];
    expect(answered).toHaveLength(2);
    expect(answered[0]).toMatchObject({ answeredBy: "orchestrator", answer: "Use a.ts" });
    expect(answered[1]).toMatchObject({ answeredBy: "user", answer: "user-secret" });
  });

  it("applies suggested free replacements on cost limit and finishes parked tasks without mutating roles", async () => {
    const cfg = config({ settings: "version: 1\ncostLimit:\n  perRunUsd: 0.01\n  onLimit: ask\n" });
    let firstId = "";
    let cwCalls = 0;
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "code-writer") {
        cwCalls++;
        return cwCalls === 1 ? [text("wrote 1"), done({ in: 1000, out: 1000 }, 0.05)] : [text("wrote 2 on free"), done()];
      }
      if (n === 1) return [calls(plan("code-writer", "first")), done()];
      if (n === 2) {
        const tool = [...req.messages].reverse().find((m) => m.role === "tool") as { content: string };
        firstId = JSON.parse(tool.content).taskId;
        return [calls(plan("code-writer", "second", { dependsOn: [firstId] })), done()];
      }
      return [text("done"), done()];
    });
    const { rt, events } = await runtime(cfg, channel, {
      ask: async () => "Use suggested replacements",
    });
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
    expect(events.some((e) => e.kind === "cost.replaced" && e.roleId === "code-writer" && e.agentId === "a-free")).toBe(true);
    const doneTasks = events.filter((e) => e.kind === "task.done" && e.roleId === "code-writer");
    expect(doneTasks).toHaveLength(2);
    expect(cfg.roles.find((r) => r.id === "code-writer")!.agent).toBe("a-paid");
  });

  it("detects an AB-BA undeclared lease cycle in parallel tasks and re-queues the younger task to completion", async () => {
    const cfg = config({
      roles: {
        "code-writer": "enabled: true\n    agent: a-free\n    tools: [WriteFile]",
        "general-worker": "enabled: true\n    agent: a-free\n    tools: [WriteFile]",
      },
    });
    let bothStartedResolve: () => void = () => {};
    const bothStarted = new Promise<void>((r) => (bothStartedResolve = r));
    let firstWrites = 0;
    const bumpFirst = () => {
      if (++firstWrites === 2) bothStartedResolve();
    };
    let gwAttempt = 0;
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") {
        return n === 1 ? [calls(plan("code-writer", "t1"), plan("general-worker", "t2")), done()] : [text("done"), done()];
      }
      if (role === "code-writer") {
        if (n === 1) return [calls({ id: "cw1", name: "WriteFile", arguments: { path: "a.ts", content: "cw-a" } }), done()];
        if (n === 2) return [calls({ id: "cw2", name: "WriteFile", arguments: { path: "b.ts", content: "cw-b" } }), done()];
        return [text("cw done"), done()];
      }
      if (role === "general-worker") {
        gwAttempt++;
        if (gwAttempt === 1 || gwAttempt === 3) {
          return [calls({ id: `gw1-${gwAttempt}`, name: "WriteFile", arguments: { path: "b.ts", content: "gw-b" } }), done()];
        }
        if (gwAttempt === 2 || gwAttempt === 4) {
          return [calls({ id: `gw2-${gwAttempt}`, name: "WriteFile", arguments: { path: "a.ts", content: "gw-a" } }), done()];
        }
        return [text("gw done"), done()];
      }
      return [text("ok"), done()];
    });
    const { rt, files } = await runtime(cfg, channel, { leaseWaitMs: 2000 });
    const origEdit = rt.host.files.edit;
    rt.host.files.edit = async (e) => {
      const res = await origEdit(e);
      if (firstWrites < 2) {
        bumpFirst();
        await bothStarted;
      }
      return res;
    };
    const out = await runOrchestrated(rt, "parallel writes");
    expect(out.status).toBe("done");
    expect(files["a.ts"]).toBe("gw-a");
    expect(files["b.ts"]).toBe("gw-b");
  });
});

describe("RunManager orchestrated status", () => {
  const mk = (roles?: Record<string, string>, settings?: string) => {
    const cfg = config({ roles, settings });
    const script = (role: string, n: number): ChatEvent[] =>
      role === "orchestrator"
        ? n === 1
          ? [calls({ id: "c-d", name: "dispatch", arguments: { role: "investigator", task: "look" } }), done()]
          : [text("ok"), done()]
        : [text("looked"), done()];
    const { channel } = fakeChannel(script);
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    return { manager, opts: { config: cfg, channelFor: () => channel }, events };
  };

  it("persists stopped (not done) when the Orchestrator hits its turn budget", async () => {
    const { manager, opts, events } = mk(
      {
        orchestrator: "enabled: true\n    agent: a-paid\n    tools: [dispatch, ask_user, ReadFile, FindFiles]\n    turnBudget: 1",
      },
      "maxRecoveriesPerRun: 0",
    );
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("stopped"));
    expect(events.find((e) => e.kind === "run.finished")).toMatchObject({ status: "stopped", error: "turn limit reached" });
  });

  it("persists done for a completed run that dispatched work", async () => {
    const { manager, opts, events } = mk();
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    expect(events.find((e) => e.kind === "run.finished")).toMatchObject({ status: "done" });
  });

  it("persists no_dispatch and attaches the warning to run.finished", async () => {
    const cfg = config();
    const { channel } = fakeChannel(() => [text("just prose"), done()]);
    const events: RunEvent[] = [];
    const fake = fakeHost({ "a.ts": "a" });
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    const run = await manager.orchestrated("p", { config: cfg, channelFor: () => channel, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("no_dispatch"));
    expect(events.find((e) => e.kind === "run.finished")).toMatchObject({
      status: "no_dispatch",
      error: expect.stringContaining("Last reply: just prose"),
    });
  });
});

describe("RunManager run time cap", () => {
  /**
   * Manual clock. `timers` records every arm (tool-timeout timers excluded, they share the clock but are not the run cap);
   * `fire()` runs the pending, uncancelled cap timers.
   */
  const manualClock = (start = 1_000_000) => {
    let t = start;
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    const clock: Clock = {
      now: () => t,
      setTimeout: (fn, ms) => {
        const rec = { ms, fn, cancelled: false };
        if (ms !== DEFAULT_LIMITS.toolTimeoutMs) timers.push(rec);
        return { cancel: () => (rec.cancelled = true) };
      },
    };
    const fire = () => {
      for (const r of timers) {
        if (r.cancelled) continue;
        r.cancelled = true;
        r.fn();
      }
    };
    return { clock, timers, fire };
  };
  const mk = (clock: Clock, script: Script, settings?: string) => {
    const cfg = config({ settings });
    const { channel, calls: seen } = fakeChannel(script);
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const manager = new RunManager({ host: fake.host, clock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    return { manager, opts: { config: cfg, channelFor: () => channel }, events, fake, seen };
  };
  const finished = (events: RunEvent[]) => events.find((e) => e.kind === "run.finished");

  it("stops an orchestrated run when the cap timer fires mid-run (stopped, not cancelled)", async () => {
    const mc = manualClock();
    const script: Script = (role, n) =>
      role === "orchestrator" && n === 1
        ? (mc.fire(), [calls({ id: "c-d", name: "dispatch", arguments: { role: "investigator", task: "look" } }), done()])
        : [text("ok"), done()];
    const { manager, opts, events } = mk(mc.clock, script, "version: 1\nmaxRunHours: 1\n");
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("interrupted"));
    expect(finished(events)).toMatchObject({ status: "stopped", error: "run time limit reached (60min)" });
  });

  it("stops a resumed run whose startedAt is already past the cap, before re-dispatching", async () => {
    const instant: Clock = { now: () => 2 * 3_600_000, setTimeout: (fn) => (fn(), { cancel: () => {} }) };
    const { manager, opts, events, fake, seen } = mk(instant, () => [text("never"), done()], "version: 1\nmaxRunHours: 1\n");
    fake.files["/tmp/st/scratch/run-late/run.json"] = JSON.stringify({
      id: "run-late",
      projectId: "p",
      text: "update a.ts",
      status: "running",
      startedAt: 0,
      costUsd: 0,
      tasks: [{ id: "task-1", roleId: "code-writer", title: "write a.ts", task: "write a.ts", files: ["a.ts"], dependsOn: [], status: "running" }],
    });
    const res = await manager.resume("p", "run-late", { config: opts.config, channelFor: opts.channelFor });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(manager.get("run-late")!.status).toBe("interrupted"));
    expect(finished(events)).toMatchObject({ status: "stopped", error: "run time limit reached (60min)" });
    expect(seen.some((s) => s.startsWith("code-writer"))).toBe(false);
    expect(fake.files["a.ts"]).toBe("a");
  });

  it("cancels the cap timer after normal completion so a later fire changes nothing", async () => {
    const mc = manualClock();
    const { manager, opts, events } = mk(mc.clock, (role, n) => (role === "orchestrator" && n === 1 ? [text("nothing to do"), done()] : [text("ok"), done()]), "version: 1\nmaxRunHours: 1\n");
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("no_dispatch"));
    expect(mc.timers).toHaveLength(1);
    expect(mc.timers[0]!.cancelled).toBe(true);
    mc.fire();
    expect(manager.get(run.id)!.status).toBe("no_dispatch");
    expect(events.some((e) => e.kind === "run.finished" && e.status === "stopped")).toBe(false);
  });

  it("never arms a timer when maxRunHours and the profile maxRunMinutes are both 0", async () => {
    const mc = manualClock();
    const { manager, opts, events } = mk(mc.clock, (role, n) =>
      role === "orchestrator" && n === 1
        ? [calls({ id: "c-d", name: "dispatch", arguments: { role: "investigator", task: "look" } }), done()]
        : [text("ok"), done()],
    );
    const run = await manager.orchestrated("p", { ...opts, text: "go", profile: { ...DEFAULT_BUDGET_PROFILES.normal, maxRunMinutes: 0 } });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    expect(mc.timers).toHaveLength(0);
    expect(finished(events)).toMatchObject({ status: "done" });
  });

  it("reports a user cancel as cancelled, not stopped, even with the cap armed", async () => {
    const mc = manualClock();
    const { manager, opts, events } = mk(mc.clock, (role, n) => {
      if (role === "orchestrator" && n === 1) {
        manager.cancel(runIdRef.id);
        return [text("cancelled"), done()];
      }
      return [text("ok"), done()];
    }, "version: 1\nmaxRunHours: 1\n");
    const runIdRef = { id: "" };
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    runIdRef.id = run.id;
    await vi.waitFor(() => expect(finished(events)).toBeDefined());
    expect(manager.get(run.id)!.status).toBe("cancelled");
    expect(finished(events)).toMatchObject({ status: "cancelled" });
  });
});

describe("RunManager resume", () => {
  const mk = async () => {
    const cfg = config();
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? [text(n === 1 ? "first" : "second"), done()] : [text("ok"), done()]));
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const bus = new EventBus((e) => events.push(e), 0);
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
    const opts = { config: cfg, channelFor: () => channel };
    return { manager, opts, events, fake };
  };

  it("refuses an unknown run id", async () => {
    const { manager, opts } = await mk();
    expect(await manager.resume("p", "run-404", opts)).toEqual({ ok: false, reason: "run not found" });
  });

  it("refuses a run that already finished", async () => {
    const { manager, opts } = await mk();
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("no_dispatch"));
    expect(await manager.resume("p", run.id, opts)).toEqual({ ok: false, reason: "run is no_dispatch" });
  });

  it("fails closed for an interrupted in-memory run instead of replaying the prompt", async () => {
    const { manager, opts, events, fake } = await mk();
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("no_dispatch"));
    manager.get(run.id)!.status = "interrupted";
    const before = { ...fake.files };
    const res = await manager.resume("p", run.id, opts);
    expect(res).toEqual({ ok: false, reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes" });
    expect(events.filter((e) => e.kind === "run.started")).toHaveLength(1);
    expect(fake.files).toEqual(before);
  });

  it("fails closed for a persisted running journal after a restart", async () => {
    const { manager, opts, fake, events } = await mk();
    fake.files["/tmp/st/scratch/run-old/run.json"] = JSON.stringify({ id: "run-old", projectId: "p", text: "go", status: "running" });
    const res = await manager.resume("p", "run-old", opts);
    expect(res).toEqual({ ok: false, reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes" });
    expect(events.some((e) => e.kind === "run.started")).toBe(false);
  });

  it("fails closed for an unreadable journal with the same warning", async () => {
    const { manager, opts, fake } = await mk();
    fake.files["/tmp/st/scratch/run-bad/run.json"] = "{not json";
    expect(await manager.resume("p", "run-bad", opts)).toEqual({
      ok: false,
      reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes",
    });
  });

  it("reconstructs a persisted task graph on resume, marks in-flight tasks interrupted, and skips executed idempotency keys", async () => {
    const cfg = config();
    let writeExecutions = 0;
    const { channel } = fakeChannel((role, n) => {
      if (role === "code-writer") {
        return n === 1
          ? [calls({ id: "w1", name: "WriteFile", arguments: { path: "a.ts", content: "written-once" } }), done({ in: 100, out: 50 }, 0.01)]
          : [text("task finished after resume"), done({ in: 100, out: 50 }, 0.01)];
      }
      return [text("ok"), done()];
    });
    const fake = fakeHost({ "a.ts": "already-landed" });
    const origEdit = fake.host.files.edit;
    fake.host.files.edit = async (e) => {
      writeExecutions++;
      return origEdit(e);
    };
    fake.files["/tmp/st/scratch/run-crash/run.json"] = JSON.stringify({
      id: "run-crash",
      projectId: "p",
      text: "update a.ts",
      status: "running",
      startedAt: 100,
      costUsd: 0.02,
      tasks: [
        {
          id: "task-1",
          roleId: "code-writer",
          title: "write a.ts",
          task: "write a.ts",
          files: ["a.ts"],
          dependsOn: [],
          status: "running",
          filesTouched: ["a.ts"],
        },
      ],
    });
    fake.files["/tmp/st/scratch/run-crash/executed.jsonl"] = `${JSON.stringify({ key: "run-crash:task-1:0", content: "wrote a.ts (1 lines)" })}\n`;
    const events: RunEvent[] = [];
    const bus = new EventBus((e) => events.push(e), 0);
    const manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
    const res = await manager.resume("p", "run-crash", { config: cfg, channelFor: () => channel });
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(manager.get("run-crash")?.status).toBe("done"));
    expect(writeExecutions).toBe(0);
    expect(fake.files["a.ts"]).toBe("already-landed");
    expect(events.some((e) => e.kind === "task.failed" && e.error === "failed: interrupted")).toBe(true);
    expect(events.some((e) => e.kind === "task.done" && e.taskId === "task-1")).toBe(true);
  });

  it("reverts run changes across multiple tasks and deletes newly created files", async () => {
    const cfg = config({
      roles: {
        "code-writer": "enabled: true\n    agent: a-free\n    tools: [WriteFile]",
      },
    });
    const { channel } = fakeChannel((role, n) => {
      if (role === "orchestrator") {
        if (n === 1) return [calls({ id: "d1", name: "dispatch", arguments: { role: "code-writer", task: "first" } }), done()];
        if (n === 2) return [calls({ id: "d2", name: "dispatch", arguments: { role: "code-writer", task: "second" } }), done()];
        return [text("done"), done()];
      }
      if (role === "code-writer") {
        if (n === 1) return [calls({ id: "w1", name: "WriteFile", arguments: { path: "a.ts", content: "v1" } }), done()];
        if (n === 3) {
          return [
            calls(
              { id: "w2", name: "WriteFile", arguments: { path: "a.ts", content: "v2" } },
              { id: "w3", name: "WriteFile", arguments: { path: "created.ts", content: "new" } },
            ),
            done(),
          ];
        }
        return [text("ok"), done()];
      }
      return [text("ok"), done()];
    });
    const fake = fakeHost({ "a.ts": "original-a" });
    const events: RunEvent[] = [];
    let manager!: RunManager;
    const bus = new EventBus((e) => {
      events.push(e);
      if (e.kind === "approval.request") manager.approve(e.approvalId, "always");
    }, 0);
    manager = new RunManager({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
    const run = await manager.orchestrated("p", { config: cfg, channelFor: () => channel, text: "edit" });
    await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("done"));
    expect(fake.files["a.ts"]).toBe("v2");
    expect(fake.files["created.ts"]).toBe("new");

    const rev = await manager.revert(run.id);
    expect(rev.ok).toBe(true);
    expect(rev.filesRestored.sort()).toEqual(["a.ts", "created.ts"]);
    expect(fake.files["a.ts"]).toBe("original-a");
    expect(fake.files["created.ts"]).toBeUndefined();
    expect(events.some((e) => e.kind === "run.reverted" && e.runId === run.id)).toBe(true);
    expect((await manager.revert("run-missing")).ok).toBe(false);
  });
});

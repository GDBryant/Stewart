import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "../src/channels/types.js";
import { ManagedChannel } from "../src/channels/registry.js";
import { EventBus } from "../src/events.js";
import { loadConfig, type Config } from "../src/config/loader.js";
import { counterIds, systemClock } from "../src/ports.js";
import { RunManager } from "../src/runManager.js";
import { TaskGraph } from "../src/orchestration/tasks.js";
import { LeaseManager } from "../src/orchestration/leases.js";
import { RunLedger, CostLimit, costOfCall, isCosting } from "../src/orchestration/ledger.js";
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
import { fakeHost } from "./helpers.js";
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

  it("falls back to General Worker for a disabled role", async () => {
    const cfg = config({ roles: { "code-writer": "enabled: false\n    agent: a-paid" } });
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? (n === 1 ? [calls(plan("code-writer", "x")), done()] : [text("done"), done()]) : [text("ok"), done()]));
    const { rt, events } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(events.find((e) => e.kind === "task.created")).toMatchObject({ roleId: "general-worker" });
  });

  it("fails a dispatch when no role and no fallback is enabled", async () => {
    const cfg = config({ roles: { "code-writer": "enabled: false\n    agent: a-paid", "general-worker": "enabled: false\n    agent: a-free" } });
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? (n === 1 ? [calls(plan("code-writer", "x")), done()] : [text("done"), done()]) : [text("ok"), done()]));
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
  });

  it("stops dispatching after maxRunHours", async () => {
    const cfg = config({ settings: "version: 1\nmaxRunHours: 1\n" });
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? (n === 1 ? [calls(plan("investigator", "x")), done()] : [text("done"), done()]) : [text("ok"), done()]));
    const { rt, events } = await runtime(cfg, channel, { startedAt: systemClock.now() - 2 * 3_600_000 });
    const out = await runOrchestrated(rt, "go");
    expect(out.status).toBe("done");
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
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    expect(await manager.resume("p", run.id, opts)).toEqual({ ok: false, reason: "run is done" });
  });

  it("resumes an interrupted run under the same id so the idempotency log applies", async () => {
    const { manager, opts, events } = await mk();
    const run = await manager.orchestrated("p", { ...opts, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("done"));
    manager.get(run.id)!.status = "interrupted";
    const res = await manager.resume("p", run.id, opts);
    expect(res.ok).toBe(true);
    expect(res.run!.id).toBe(run.id);
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "run.started")).toHaveLength(2));
  });

  it("resumes from the journal after a restart", async () => {
    const { manager, opts, fake, events } = await mk();
    const journal = "/tmp/st/scratch/run-old/run.json";
    fake.files[journal] = JSON.stringify({ id: "run-old", projectId: "p", text: "go", status: "running" });
    const res = await manager.resume("p", "run-old", opts);
    expect(res.ok).toBe(true);
    expect(res.run!.id).toBe("run-old");
    await vi.waitFor(() => expect(events.some((e) => e.kind === "run.finished" && e.runId === "run-old")).toBe(true));
  });

  it("refuses an unreadable journal", async () => {
    const { manager, opts, fake } = await mk();
    fake.files["/tmp/st/scratch/run-bad/run.json"] = "{not json";
    expect(await manager.resume("p", "run-bad", opts)).toEqual({ ok: false, reason: "run journal is unreadable" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "@stewart/channels";
import { ManagedChannel } from "@stewart/channels";
import { EventBus } from "@stewart/kernel";
import { loadConfig, type Config } from "@stewart/roles-skills";
import { counterIds, systemClock, type Clock } from "@stewart/kernel";
import { RunService } from "../src/api.js";
import { DEFAULT_BUDGET_PROFILES, DEFAULT_LIMITS } from "@stewart/budget";
import { TaskGraph, LeaseManager } from "@stewart/scheduling";
import { isCosting } from "@stewart/models";
import { RunLedger, CostLimit, costOfCall } from "@stewart/ledger";
import { IdempotencyLog } from "@stewart/run-state";
import { createRecovery } from "@stewart/recovery";
import { freeCandidates, parseReplacements, rankDeterministic, validateReplacements } from "@stewart/orchestration";
import { LeaseCycleError, LeaseTimeoutError } from "@stewart/run-state";
import { leasedTools } from "@stewart/tools";
import { runRoleTask } from "@stewart/orchestration";
import { runOrchestrated } from "@stewart/orchestration";
import { orchestrationTools, type OrchestrationHandlers } from "@stewart/orchestration";
import type { RunRuntime } from "@stewart/run-contract";
import { projectTools } from "@stewart/tools";
import { ProjectPaths } from "@stewart/tools";
import { ToolLoop } from "@stewart/agent-loop";
import { ToolRegistry } from "@stewart/tools";
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
  over: Partial<RunRuntime> & { files?: Record<string, string> } = {},
): Promise<{ rt: RunRuntime; events: RunEvent[]; files: Record<string, string>; host: ReturnType<typeof fakeHost>["host"] }> {
  const fake = fakeHost(over.files ?? { "a.ts": "a", "b.ts": "b" });
  const events: RunEvent[] = [];
  const bus = new EventBus((e) => events.push(e), 0);
  const ledger = new RunLedger(fake.host, "/tmp/st/ledger.jsonl", systemClock);
  await ledger.load();
  const idem = new IdempotencyLog(fake.host, "/tmp/st/scratch/run-1/executed.jsonl", "run-1");
  await idem.load();
  const rt: RunRuntime = {
    recoveryService: createRecovery(runRoleTask),
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
    prompt: async (p: { decode(a: string): unknown }) => ({ kind: "answered" as const, value: p.decode("Stop") }),
    approve: async () => ({ kind: "approved" }),
    ...over,
  };
  return { rt, events, files: fake.files, host: fake.host };
}

describe("RunService orchestrated status", () => {
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
    const run = await manager.orchestrated("p", { config: cfg, channelFor: () => channel, text: "go" });
    await vi.waitFor(() => expect(manager.get(run.id)!.status).toBe("no_dispatch"));
    expect(events.find((e) => e.kind === "run.finished")).toMatchObject({
      status: "no_dispatch",
      error: expect.stringContaining("Last reply: just prose"),
    });
  });
});

describe("RunService run time cap", () => {
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
    const manager = new RunService({ host: fake.host, clock, ids: counterIds(), bus: new EventBus((e) => events.push(e), 0) });
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

describe("RunService resume", () => {
  const mk = async () => {
    const cfg = config();
    const { channel } = fakeChannel((role, n) => (role === "orchestrator" ? [text(n === 1 ? "first" : "second"), done()] : [text("ok"), done()]));
    const fake = fakeHost({ "a.ts": "a" });
    const events: RunEvent[] = [];
    const bus = new EventBus((e) => events.push(e), 0);
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
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
    const manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
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
    let manager!: RunService;
    const bus = new EventBus((e) => {
      events.push(e);
      if (e.kind === "approval.request") manager.approve(e.approvalId, "always");
    }, 0);
    manager = new RunService({ host: fake.host, clock: systemClock, ids: counterIds(), bus });
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

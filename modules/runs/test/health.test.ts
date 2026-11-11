import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChatEvent, ChatRequest } from "@stewart/channels";
import { ManagedChannel } from "@stewart/channels";
import { counterIds, EventBus, fakeHost, systemClock } from "@stewart/kernel";
import { loadEffectiveConfig, type EffectiveConfig } from "@stewart/roles-skills";
import { LeaseManager } from "@stewart/scheduling";
import { RunLedger, CostLimit } from "@stewart/ledger";
import { IdempotencyLog } from "@stewart/run-state";
import { createRecovery } from "@stewart/recovery";
import { runOrchestrated, runRoleTask } from "@stewart/orchestration";
import { healthCheckFeature } from "@stewart/health-check";
import type { RunRuntime } from "@stewart/run-contract";
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

function config(opts: { roles?: Record<string, string>; settings?: string } = {}): EffectiveConfig {
  return loadEffectiveConfig(
    { "channels.yaml": CHANNELS, "agents.yaml": AGENTS, "roles.yaml": rolesYaml(opts.roles), "settings.yaml": opts.settings },
    {},
    {},
    true,
  );
}

async function runtime(
  cfg: EffectiveConfig,
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
    features: [healthCheckFeature],
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

const healthTools = (rt: RunRuntime) => healthCheckFeature.createRun(rt, { tasks: () => [], maxOutputChars: 20_000 }).taskTools("t1");

describe("health verbs", () => {
  const reviewerCfg = () =>
    config({
      roles: {
        "code-health-reviewer": "enabled: true\n    agent: a-free\n    tools: [ReadFile, submit_health]",
        orchestrator: "enabled: true\n    agent: a-paid\n    tools: [dispatch, ask_user, health_report]",
      },
    });
  const healthArgs = {
    files: [{ path: "a.ts", loc: 100, score: 10, band: "Green" }, { path: "b.ts", loc: 900, score: 5, band: "Red" }],
    findings: [{ path: "b.ts", line: 3, smell: "god-class", severity: "high", refactor: "split" }],
    notChecked: [],
  };

  it("a reviewer task calling submit_health ends the turn with the short summary", async () => {
    const cfg = reviewerCfg();
    const { channel } = fakeChannel((role) =>
      role === "code-health-reviewer" ? [calls({ id: "h1", name: "submit_health", arguments: healthArgs }), done()] : [text("x"), done()],
    );
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "code-health-reviewer", title: "t", task: "review", files: [], dependsOn: [] }, {
      role: cfg.roles.find((r) => r.id === "code-health-reviewer")!,
      nestedTools: healthTools(rt),
    });
    expect(res.status).toBe("done");
    expect(res.summary).toContain("Health report recorded");
  });

  it("a malformed submit_health is rejected by schema and the loop continues", async () => {
    const cfg = reviewerCfg();
    let n = 0;
    const { channel } = fakeChannel((role) => {
      if (role !== "code-health-reviewer") return [text("x"), done()];
      n++;
      return n === 1
        ? [calls({ id: "h1", name: "submit_health", arguments: { findings: [] } }), done()]
        : [calls({ id: "h2", name: "submit_health", arguments: healthArgs }), done()];
    });
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "code-health-reviewer", title: "t", task: "review", files: [], dependsOn: [] }, {
      role: cfg.roles.find((r) => r.id === "code-health-reviewer")!,
      nestedTools: healthTools(rt),
    });
    expect(n).toBe(2);
    expect(res.status).toBe("done");
    expect(res.summary).toContain("Health report recorded");
  });

  it("submit_health accepts checks and counts them in the summary", async () => {
    const cfg = reviewerCfg();
    const args = {
      files: [],
      checks: [{ name: "unit", command: "npm test", status: "pass", detail: "10/10" }],
    };
    const { channel } = fakeChannel((role, n) => {
      if (role === "code-health-reviewer") return [calls({ id: "h1", name: "submit_health", arguments: args }), done()];
      if (role === "orchestrator" && n === 1) {
        return [calls({ id: "d1", name: "dispatch", arguments: { role: "code-health-reviewer", task: "Project checks" } }), done()];
      }
      return [text("done"), done()];
    });
    const { rt, events } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "check the health of this project");
    expect(out.status).toBe("done");
    const doneEv = events.find((e) => e.kind === "task.done") as Extract<RunEvent, { kind: "task.done" }> | undefined;
    expect(doneEv?.summary).toBe("Project checks recorded: 1");
  });

  it("a check with a bad status is rejected by schema and the loop continues", async () => {
    const cfg = reviewerCfg();
    let n = 0;
    const bad = { files: [], checks: [{ name: "t", command: "x", status: "bogus", detail: "" }] };
    const { channel } = fakeChannel((role) => {
      if (role !== "code-health-reviewer") return [text("x"), done()];
      n++;
      return n === 1
        ? [calls({ id: "h1", name: "submit_health", arguments: bad }), done()]
        : [calls({ id: "h2", name: "submit_health", arguments: healthArgs }), done()];
    });
    const { rt } = await runtime(cfg, channel);
    const res = await runRoleTask(rt, { id: "t1", roleId: "code-health-reviewer", title: "t", task: "review", files: [], dependsOn: [] }, {
      role: cfg.roles.find((r) => r.id === "code-health-reviewer")!,
      nestedTools: healthTools(rt),
    });
    expect(n).toBe(2);
    expect(res.status).toBe("done");
    expect(res.summary).toContain("Health report recorded");
  });

  it("health_report merges two recorded reports, returns weighted overall and writes scratch", async () => {
    const cfg = reviewerCfg();
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "code-health-reviewer") {
        const user = req.messages.find((m) => m.role === "user")?.content ?? "";
        const report = user.includes("batch-b")
          ? { files: [{ path: "b.ts", loc: 900, score: 5, band: "Red" }], findings: [], notChecked: [] }
          : { files: [{ path: "a.ts", loc: 100, score: 10, band: "Green" }], findings: [], notChecked: [] };
        return [calls({ id: `h${n}`, name: "submit_health", arguments: report }), done()];
      }
      if (n === 1) {
        return [
          calls(
            { id: "d1", name: "dispatch", arguments: { role: "code-health-reviewer", task: "batch-a" } },
            { id: "d2", name: "dispatch", arguments: { role: "code-health-reviewer", task: "batch-b" } },
          ),
          done(),
        ];
      }
      if (n === 2) return [calls({ id: "r1", name: "health_report", arguments: { mode: "score" } }), done()];
      return [text("done"), done()];
    });
    const { rt, files } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "check the health of this project");
    expect(out.status).toBe("done");
    const report = files[".stewart/scratch/health/run-1.md"];
    expect(report).toBeDefined();
    expect(report).toContain("Overall: 5.5/10 (Red)");
    expect(report).toContain("Checked: 2 files / 1000 LOC");
  });

  it("health_report adds the lexical Measured line and project checks section", async () => {
    const cfg = reviewerCfg();
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "code-health-reviewer") {
        const user = req.messages.find((m) => m.role === "user")?.content ?? "";
        const report = user.includes("checks")
          ? { files: [], checks: [{ name: "unit", command: "npm test", status: "pass", detail: "10/10" }] }
          : { files: [{ path: "a.ts", loc: 100, score: 10, band: "Green" }], findings: [], notChecked: [] };
        return [calls({ id: `h${n}`, name: "submit_health", arguments: report }), done()];
      }
      if (n === 1) {
        return [
          calls(
            { id: "d1", name: "dispatch", arguments: { role: "code-health-reviewer", task: "batch" } },
            { id: "d2", name: "dispatch", arguments: { role: "code-health-reviewer", task: "checks" } },
          ),
          done(),
        ];
      }
      if (n === 2) return [calls({ id: "r1", name: "health_report", arguments: {} }), done()];
      return [text("done"), done()];
    });
    const { rt, files } = await runtime(cfg, channel, { files: { "a.ts": "function f() {\n  if (x) return 1\n}" } });
    const out = await runOrchestrated(rt, "check the health of this project");
    expect(out.status).toBe("done");
    const report = files[".stewart/scratch/health/run-1.md"];
    const lines = report.split("\n");
    expect(lines[2]).toContain("Measured (lexical scan, approximate): 1 files / 3 LOC");
    expect(report).toContain("Project checks:");
    expect(report).toContain("- unit: pass — `npm test` — 10/10");
  });

  it("health_report omits the Measured line when no file can be read", async () => {
    const cfg = reviewerCfg();
    const { channel } = fakeChannel((role, n) => {
      if (role === "code-health-reviewer") {
        return [calls({ id: `h${n}`, name: "submit_health", arguments: { files: [{ path: "missing.ts", loc: 5, score: 9, band: "Yellow" }], findings: [], notChecked: [] } }), done()];
      }
      if (n === 1) {
        return [calls({ id: "d1", name: "dispatch", arguments: { role: "code-health-reviewer", task: "batch" } }), done()];
      }
      if (n === 2) return [calls({ id: "r1", name: "health_report", arguments: {} }), done()];
      return [text("done"), done()];
    });
    const { rt, files } = await runtime(cfg, channel, { files: { "a.ts": "x" } });
    const out = await runOrchestrated(rt, "check the health of this project");
    expect(out.status).toBe("done");
    const report = files[".stewart/scratch/health/run-1.md"];
    expect(report).not.toContain("Measured (lexical scan");
  });

  it("health_report with no recorded reports returns the empty message", async () => {
    const cfg = reviewerCfg();
    let reply = "";
    const { channel } = fakeChannel((role, n, req) => {
      if (role !== "orchestrator") return [text("x"), done()];
      if (n === 1) return [calls({ id: "d0", name: "dispatch", arguments: { role: "general-worker", task: "noop" } }), done()];
      if (n === 2) return [calls({ id: "r1", name: "health_report", arguments: {} }), done()];
      reply = [...req.messages].reverse().find((m) => m.role === "tool")?.content as string;
      return [text("done"), done()];
    });
    const { rt } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(reply).toBe("No health reports recorded.");
  });

  it("a non-orchestrator role cannot call health_report", async () => {
    const cfg = reviewerCfg();
    let toolNames: string[] = [];
    const { channel } = fakeChannel((role, n, req) => {
      if (role === "code-health-reviewer") {
        toolNames = (req.tools ?? []).map((t) => t.name);
        return [text("reviewed"), done()];
      }
      return n === 1 ? [calls({ id: "d1", name: "dispatch", arguments: { role: "code-health-reviewer", task: "batch" } }), done()] : [text("done"), done()];
    });
    const { rt } = await runtime(cfg, channel);
    await runOrchestrated(rt, "go");
    expect(toolNames).not.toContain("health_report");
    expect(toolNames).toContain("submit_health");
  });

  it("fails a project health request when code-health-reviewer is not enabled", async () => {
    const cfg = reviewerCfg();
    cfg.roles.find((r) => r.id === "code-health-reviewer")!.enabled = false;
    const { channel } = fakeChannel(() => [text("x"), done()]);
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "check the health of this project");
    expect(out.status).toBe("failed");
    expect(out.error).toContain("code-health-reviewer is not enabled");
  });

  it("proceeds on a health request when the reviewer is enabled", async () => {
    const cfg = reviewerCfg();
    const { channel } = fakeChannel((role, n) =>
      role === "orchestrator" ? (n === 1 ? [calls({ id: "d1", name: "dispatch", arguments: { role: "code-health-reviewer", task: "batch" } }), done()] : [text("done"), done()]) : [text("ok"), done()],
    );
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "check the health of this project");
    expect(out.status).toBe("done");
  });

  it("proceeds on a non-health request even when the reviewer is disabled", async () => {
    const cfg = reviewerCfg();
    cfg.roles.find((r) => r.id === "code-health-reviewer")!.enabled = false;
    const { channel } = fakeChannel((role, n) =>
      role === "orchestrator" ? (n === 1 ? [calls({ id: "d1", name: "dispatch", arguments: { role: "general-worker", task: "x" } }), done()] : [text("done"), done()]) : [text("ok"), done()],
    );
    const { rt } = await runtime(cfg, channel);
    const out = await runOrchestrated(rt, "rename a variable");
    expect(out.status).toBe("done");
  });
});

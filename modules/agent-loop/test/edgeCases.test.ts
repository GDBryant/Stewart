import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import { fakeHost, type ChatMessage, type Clock } from "@stewart/kernel";
import { DEFAULT_LIMITS, DEFAULT_BUDGET_PROFILES } from "@stewart/budget";
import { RunLedger } from "@stewart/ledger";
import type { AgentDef, RoleDef, Settings } from "@stewart/config";
import { ToolRegistry } from "@stewart/tools";
import { createAgentSession, recoveryState, RunCancelledError, ToolLoop, type ApprovalDecision } from "../src/api.js";

function fakeChannel(turns: ChatEvent[][], onReq?: (req: unknown) => void): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* (_cfg, _s, req) {
      onReq?.(req);
      for (const ev of turns[Math.min(i++, turns.length - 1)]) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

const echoTool = {
  spec: { name: "Echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  requiresApproval: false,
  execute: async (args: Record<string, unknown>) => `echo:${String(args.text)}`,
};

const approve = async (): Promise<ApprovalDecision> => ({ kind: "approved" });
const hist: ChatMessage[] = [{ role: "user", content: "go" }];
const sig = () => new AbortController().signal;
const agent: AgentDef = { id: "a1", channel: "c", model: "m", effort: "medium" };
const clock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } };

describe("recoveryState", () => {
  it("maps settings and initialises counters", () => {
    const s = {
      maxRecoveryDepth: 2, maxRecoveriesPerRun: 3, maxSubTasks: 4, recoverySummaryChars: 100,
      maxActionsInRecoveryBrief: 5, maxContinuations: 6, maxContinueQuestionsPerRun: 7,
      askOnTurnLimit: true, continueQuestionTimeoutMinutes: 2,
    } as Settings;
    const st = recoveryState(s);
    expect(st).toMatchObject({ maxRecoveryDepth: 2, maxRecoveriesPerRun: 3, maxSubTasks: 4, recoverySummaryChars: 100, maxActionsInRecoveryBrief: 5, maxContinuations: 6, maxContinueQuestionsPerRun: 7, askOnTurnLimit: true, recoveriesUsed: 0, questionsUsed: 0 });
    expect(st.continueQuestionTimeoutMs).toBe(120_000);
  });
});

describe("RunCancelledError", () => {
  it("joins base and produced into one transcript", () => {
    const e = new RunCancelledError([{ role: "user", content: "a" }], [{ role: "assistant", content: "b" }]);
    expect(e.transcript.map((m) => m.content)).toEqual(["a", "b"]);
    expect(e.name).toBe("RunCancelledError");
  });
});

describe("createAgentSession", () => {
  const specBase = () => ({ agent, channel: fakeChannel([[{ kind: "text" as const, text: "hi" }, { kind: "done" as const, usage: { in: 3, out: 2 } }]]), registry: new ToolRegistry([echoTool]), approve });

  it("uses DEFAULT_LIMITS without a budget and applies overrides", () => {
    const s = createAgentSession({ ...specBase(), limitsOverride: { maxModelTurns: 2 } }, clock);
    expect(s.limits.maxModelTurns).toBe(2);
    expect(s.limits.toolTimeoutMs).toBe(DEFAULT_LIMITS.toolTimeoutMs);
    expect(s.profile.model).toBe("m");
  });

  it("resolves limits from the budget and caps overrides at the resolved value", () => {
    const role = { id: "r", turnBudget: 4, enabled: true } as unknown as RoleDef;
    const s = createAgentSession(
      { ...specBase(), role, budget: { profile: DEFAULT_BUDGET_PROFILES.normal, ceiling: 60 }, limitsOverride: { maxModelTurns: 999 } },
      clock,
    );
    expect(s.limits.maxModelTurns).toBe(4);
    const s2 = createAgentSession(
      { ...specBase(), role, budget: { profile: DEFAULT_BUDGET_PROFILES.normal, ceiling: 60 }, limitsOverride: { maxModelTurns: 2 } },
      clock,
    );
    expect(s2.limits.maxModelTurns).toBe(2);
  });

  it("emits stream events with run/task ids and records metered usage", async () => {
    const emitted: string[] = [];
    const { host } = fakeHost();
    const ledger = new RunLedger(host, "l.jsonl", clock);
    const cost = { accrued: 0 };
    const s = createAgentSession(
      {
        ...specBase(),
        events: { bus: { emit: (ev) => emitted.push(ev.kind) }, runId: "r1", taskId: "t1", roleId: "role" },
        meter: { ledger, cost, runId: "r1", taskId: "t1", roleId: "role" },
        hooks: { onToolRequested: () => emitted.push("hook.req"), onToolOutcome: () => emitted.push("hook.out") },
      },
      clock,
    );
    const r = await s.loop.run("m", hist, s.listener, sig());
    expect(r.kind).toBe("completed");
    expect(emitted).toContain("text_delta");
    expect(cost.accrued).toBe(0);
    await ledger.load();
    expect(ledger.entries?.length ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe("ToolLoop stream outcomes", () => {
  it("fails with protocol_error when events arrive after done", async () => {
    const ch = fakeChannel([[{ kind: "done" }, { kind: "text", text: "late" }]]);
    const r = await new ToolLoop(ch, new ToolRegistry([]), approve).run("m", hist, {}, sig());
    expect(r.kind === "failed" && r.code === "protocol_error").toBe(true);
  });

  it("fails with incomplete_stream when no done arrives", async () => {
    const ch = fakeChannel([[{ kind: "text", text: "partial" }]]);
    const r = await new ToolLoop(ch, new ToolRegistry([]), approve).run("m", hist, {}, sig());
    expect(r.kind === "failed" && r.code === "incomplete_stream").toBe(true);
  });

  it("propagates a provider error as failed", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* () {
        throw new Error("provider down");
      },
    };
    const r = await new ToolLoop(new ManagedChannel(adapter, { id: "c", type: "f", enabled: true, maxParallel: 1 }), new ToolRegistry([]), approve).run("m", hist, {}, sig());
    expect(r.kind === "failed" && r.message).toBe("provider down");
  });

  it("times out a model call and reports call_timeout", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* (_c, _s, req) {
        await new Promise((_, rej) => {
          req.signal.addEventListener("abort", () => rej(new Error("aborted")));
          setTimeout(() => rej(new Error("too slow")), 500);
        });
      },
    };
    const loop = new ToolLoop(new ManagedChannel(adapter, { id: "c", type: "f", enabled: true, maxParallel: 1 }), new ToolRegistry([]), approve, { ...DEFAULT_LIMITS, modelCallTimeoutMs: 10 });
    const r = await loop.run("m", hist, {}, sig());
    expect(r.kind === "failed" && r.code === "call_timeout").toBe(true);
  });
});

describe("ToolLoop call execution edge cases", () => {
  const shimCall = (name: string, args: string) => '<tool_' + 'call>{"name":"' + name + '","arguments":' + args + "}</tool_" + "call>";

  it("runs parallel tools in one batch", async () => {
    const ran: string[] = [];
    const mk = (name: string) => ({
      spec: { name, description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: false,
      parallel: true,
      execute: async () => {
        ran.push(name);
        await new Promise((r) => setTimeout(r, 5));
        return name;
      },
    });
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "1", name: "P1", arguments: {} }, { id: "2", name: "P2", arguments: {} }] }, { kind: "done" }],
      [{ kind: "done" }],
    ]);
    const reg = new ToolRegistry([mk("P1"), mk("P2")] as never);
    const r = await new ToolLoop(ch, reg, approve, DEFAULT_LIMITS, clock, undefined, undefined, "native").run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
    expect(ran.sort()).toEqual(["P1", "P2"]);
  });

  it("a terminal tool ends the turn and remaining calls are marked not executed", async () => {
    const mk = (name: string) => ({
      spec: { name, description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: false,
      execute: async () => "done-" + name,
    });
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "1", name: "Final", arguments: {} }, { id: "2", name: "After", arguments: {} }] }, { kind: "done" }],
    ]);
    const r = await new ToolLoop(ch, new ToolRegistry([mk("Final"), mk("After")] as never), approve, DEFAULT_LIMITS, clock, undefined, new Set(["Final"]), "native").run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
    const msgs = r.messages.filter((m) => m.role === "tool");
    expect(msgs.some((m) => m.content.includes("ended the turn"))).toBe(true);
  });

  it("replays idempotent results and records new ones", async () => {
    const store = new Map<string, string>();
    const idem = {
      key: (_c: never, i: number) => `k${i}`,
      lookup: (k: string) => store.get(k),
      record: async (k: string, v: string) => void store.set(k, v),
    };
    let execs = 0;
    const t = { ...echoTool, execute: async () => (execs++, "res") };
    const mk = () => fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Echo", arguments: { text: "x" } }] }, { kind: "done" }], [{ kind: "done" }]]);
    const reg = new ToolRegistry([t] as never);
    const r1 = await new ToolLoop(mk(), reg, approve, DEFAULT_LIMITS, clock, undefined, undefined, "native", idem).run("m", hist, {}, sig());
    expect(execs).toBe(1);
    const reg2 = new ToolRegistry([{ ...echoTool, execute: async () => (execs++, "res2") }] as never);
    await new ToolLoop(mk(), reg2, approve, DEFAULT_LIMITS, clock, undefined, undefined, "native", idem).run("m", hist, {}, sig());
    expect(execs).toBe(1);
    expect(r1.messages.find((m) => m.role === "tool")?.content).toBe("res");
  });

  it("truncates tool output beyond maxToolOutputChars", async () => {
    const big = "x".repeat(30_000);
    const t = { ...echoTool, execute: async () => big };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Echo", arguments: { text: "x" } }] }, { kind: "done" }], [{ kind: "done" }]]);
    const r = await new ToolLoop(ch, new ToolRegistry([t] as never), approve, { ...DEFAULT_LIMITS, maxToolOutputChars: 1000 }, clock, undefined, undefined, "native").run("m", hist, {}, sig());
    const tool = r.messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("output truncated");
  });

  it("forwards image results as a user image message", async () => {
    const t = { ...echoTool, execute: async () => ({ text: "img", images: ["data:image/png;base64,QUJD"] }) };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Echo", arguments: { text: "x" } }] }, { kind: "done" }], [{ kind: "done" }]]);
    const r = await new ToolLoop(ch, new ToolRegistry([t] as never), approve, DEFAULT_LIMITS, clock, undefined, undefined, "native").run("m", hist, {}, sig());
    const img = r.messages.find((m) => m.role === "user" && m.images);
    expect(img?.content).toContain("image from Echo");
  });

  it("a throwing preview becomes a failure outcome, not a crash", async () => {
    const t = {
      spec: { name: "Gate", description: "g", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: true,
      preview: async () => {
        throw new Error("preview blew up");
      },
      execute: async () => "never",
    };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Gate", arguments: {} }] }, { kind: "done" }], [{ kind: "done" }]]);
    const r = await new ToolLoop(ch, new ToolRegistry([t] as never), approve, DEFAULT_LIMITS, clock, undefined, undefined, "native").run("m", hist, {}, sig());
    const tool = r.messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("preview blew up");
  });

  it("a denied approval becomes a rejected outcome", async () => {
    const t = {
      spec: { name: "Gate", description: "g", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: true,
      preview: async () => ({ kind: "other" as const }),
      execute: async () => "never",
    };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Gate", arguments: {} }] }, { kind: "done" }], [{ kind: "done" }]]);
    const r = await new ToolLoop(ch, new ToolRegistry([t] as never), async () => ({ kind: "rejected", reason: "denied" }), DEFAULT_LIMITS, clock, undefined, undefined, "native").run("m", hist, {}, sig());
    expect(r.messages.find((m) => m.role === "tool")?.content).toContain("Rejected");
  });

  it("rethrows LeaseCycleError instead of wrapping it", async () => {
    const err = new Error("cycle");
    err.name = "LeaseCycleError";
    const t = { ...echoTool, execute: async () => Promise.reject(err) };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Echo", arguments: { text: "x" } }] }, { kind: "done" }]]);
    await expect(new ToolLoop(ch, new ToolRegistry([t] as never), approve, DEFAULT_LIMITS, clock, undefined, undefined, "native").run("m", hist, {}, sig())).rejects.toThrow("cycle");
  });

  it("cancel during an awaitsUser call leaves a not-answered tool message", async () => {
    const ac = new AbortController();
    const t = {
      spec: { name: "Ask", description: "a", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: false,
      awaitsUser: true,
      execute: (_a: unknown, _p: unknown, signal: AbortSignal) =>
        new Promise<string>((_res, rej) => {
          if (signal.aborted) rej(new Error("cancelled"));
          else signal.addEventListener("abort", () => rej(new Error("cancelled")));
        }),
    };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "1", name: "Ask", arguments: {} }] }, { kind: "done" }]]);
    const loop = new ToolLoop(ch, new ToolRegistry([t] as never), approve, DEFAULT_LIMITS, clock, undefined, undefined, "native");
    const err = await loop.run("m", hist, { onToolRequested: () => ac.abort() }, ac.signal).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RunCancelledError);
    const msgs = (err as RunCancelledError).produced.filter((m) => m.role === "tool");
    expect(msgs.some((m) => m.content.includes("Not answered"))).toBe(true);
  });
});

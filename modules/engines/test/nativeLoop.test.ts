import { describe, expect, it, vi } from "vitest";
import { ChannelError, ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { ChatMessage, ToolCall } from "@stewart/kernel";
import type { Tool } from "@stewart/tools";
import { ToolRegistry } from "@stewart/tools";
import type { ApproveFn } from "@stewart/permissions";
import { engineFor, nativeLoop, type EngineEvent, type EngineTurn } from "../src/api.js";
import { collect } from "@stewart/kernel";
import { budgetTurn } from "../src/nativeBudget.js";

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

const echoTool: Tool = {
  spec: { name: "Echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  requiresApproval: false,
  execute: async (args) => `echo:${String(args.text)}`,
};

const writeTool: Tool = {
  spec: { name: "WriteFile", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  requiresApproval: false,
  preview: async (args) => ({ kind: "file", path: String(args.path), before: null, after: String(args.content) }),
  execute: async () => "wrote",
};

const gatedTool: Tool = {
  spec: { name: "Gate", description: "gated", parameters: { type: "object", properties: {}, additionalProperties: false } },
  requiresApproval: true,
  preview: async () => ({ kind: "other" }),
  execute: async () => "ran",
};

const boomTool: Tool = {
  spec: { name: "Boom", description: "fails", parameters: { type: "object", properties: {}, additionalProperties: false } },
  requiresApproval: false,
  execute: async () => {
    throw new Error("kaboom");
  },
};

const terminalTool: Tool = {
  spec: { name: "RunTerminal", description: "run", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"], additionalProperties: false } },
  requiresApproval: false,
  execute: async (args) => `ran:${String(args.command)}`,
};

const approveYes: ApproveFn = async () => ({ kind: "approved" });
const approveNo: ApproveFn = async () => ({ kind: "rejected", reason: "denied by user" });

const agent = { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef;

function turn(over: Partial<EngineTurn> = {}): EngineTurn {
  return {
    sessionId: "s1",
    transcript: [{ role: "user", content: "go" }],
    system: "sys",
    agent,
    channel: fakeChannel([[{ kind: "text", text: "hi" }, { kind: "done" }]]),
    roleId: "lead",
    tools: new ToolRegistry([]),
    approve: approveYes,
    state: {},
    cwd: "/p",
    signal: new AbortController().signal,
    maxTurns: 5,
    ...over,
  };
}

function call(name: string, args: Record<string, unknown> = {}, id = "c1"): ToolCall {
  return { id, name, arguments: args };
}

const kinds = (evs: EngineEvent[]) => evs.map((e) => e.kind);
const last = (evs: EngineEvent[]) => evs[evs.length - 1];

describe("native-loop", () => {
  it("streams a text-only reply and finishes stop", async () => {
    const t = turn();
    const evs = await collect(nativeLoop.run(t));
    expect(kinds(evs)).toEqual(["text", "finished"]);
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    expect(t.transcript[1]).toMatchObject({ role: "assistant", content: "hi", toolCalls: undefined });
  });

  it("emits usage from the done event", async () => {
    const ch = fakeChannel([[{ kind: "text", text: "x" }, { kind: "done", usage: { in: 10, out: 5 }, costUsd: 0.01 }]]);
    const evs = await collect(nativeLoop.run(turn({ channel: ch })));
    expect(evs).toContainEqual({ kind: "usage", inTokens: 10, outTokens: 5, costUsd: 0.01 });
  });

  it("runs one tool call then replies", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("Echo", { text: "hey" })] }, { kind: "done" }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ]);
    const evs = await collect(nativeLoop.run(turn({ channel: ch, tools: new ToolRegistry([echoTool]) })));
    expect(kinds(evs)).toEqual(["tool.request", "tool.outcome", "text", "finished"]);
    expect(evs[0]).toMatchObject({ kind: "tool.request", callId: "c1", tool: "Echo", category: "OTHER" });
    expect(evs[1]).toMatchObject({ kind: "tool.outcome", ok: true, summary: "echo:hey" });
  });

  it("appends tool and assistant messages to the transcript", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("Echo", { text: "a" })] }, { kind: "done" }],
      [{ kind: "text", text: "ok" }, { kind: "done" }],
    ]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]) });
    await collect(nativeLoop.run(t));
    expect(t.transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(t.transcript[2]).toMatchObject({ role: "tool", toolCallId: "c1", content: "echo:a" });
  });

  it("rejects a gated tool when approval is denied", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Gate")] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([gatedTool]), approve: approveNo, maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    const outcome = evs.find((e) => e.kind === "tool.outcome");
    expect(outcome).toMatchObject({ ok: false, summary: "Rejected by user: denied by user" });
    expect(t.transcript[2]).toMatchObject({ role: "tool", content: "Rejected by user: denied by user" });
  });

  it("reports invalid arguments as an invalid outcome", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Echo", {})] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    const outcome = evs.find((e) => e.kind === "tool.outcome");
    expect(outcome).toMatchObject({ ok: false });
    expect(t.transcript[2].content).toMatch(/^Invalid tool call: missing required argument 'text'/);
  });

  it("reports an unknown tool without executing", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Nope")] }, { kind: "done" }]]);
    const t = turn({ channel: ch, maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    expect(t.transcript[2].content).toMatch(/^Invalid tool call: unknown tool 'Nope'/);
    expect(t.transcript[2].content).toContain("; available: ");
    expect(evs.find((e) => e.kind === "tool.outcome")).toMatchObject({ ok: false });
  });

  it("emits tool.request before the tool executes", async () => {
    const order: string[] = [];
    const marking: Tool = { ...terminalTool, execute: async (args) => { order.push("execute"); return `ran:${String(args.command)}`; } };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("RunTerminal", { command: "ls" })] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([marking]), maxTurns: 1 });
    for await (const ev of nativeLoop.run(t)) if (ev.kind === "tool.request") order.push("tool.request");
    expect(order).toEqual(["tool.request", "execute"]);
  });

  it("aliases a foreign tool name and notes the remapping", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Bash", { command: "ls", timeout: 5 })] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([terminalTool]), maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    const req = evs.find((e) => e.kind === "tool.request");
    expect(req).toMatchObject({ tool: "RunTerminal", args: { command: "ls" } });
    expect(evs.find((e) => e.kind === "tool.outcome")).toMatchObject({ ok: true });
    expect(t.transcript[2].content).toBe("ran:ls\n['Bash' is not a tool here; ran RunTerminal instead; ignored unknown argument(s): timeout]");
  });

  it("reports an aliased call with bad args without executing", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Bash", {})] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([terminalTool]), maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    expect(t.transcript[2].content).toMatch(/^Invalid tool call: unknown tool 'Bash' \(tried RunTerminal:/);
    expect(evs.find((e) => e.kind === "tool.outcome")).toMatchObject({ ok: false });
  });

  it("turns a throwing tool into a failure outcome", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Boom")] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([boomTool]), maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    expect(t.transcript[2].content).toBe("Error: kaboom");
    expect(evs.find((e) => e.kind === "tool.outcome")).toMatchObject({ ok: false, summary: "Error: kaboom" });
  });

  it("emits write records for write tools, ok and failed", async () => {
    const failWrite: Tool = { ...writeTool, execute: async () => { throw new Error("denied path"); } };
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("WriteFile", { path: "a.ts", content: "x" }, "w1"), call("WriteFile", { path: "b.ts", content: "y" }, "w2")] }, { kind: "done" }],
      [{ kind: "text", text: "end" }, { kind: "done" }],
    ]);
    const reg = new ToolRegistry([writeTool]);
    const t = turn({ channel: ch, tools: reg });
    const evs = await collect(nativeLoop.run(t));
    expect(evs).toContainEqual({ kind: "write", record: { path: "a.ts", ok: true } });
    expect(evs).toContainEqual({ kind: "write", record: { path: "b.ts", ok: true } });
    const t2 = turn({
      channel: fakeChannel([[{ kind: "tool_calls", calls: [call("WriteFile", { path: "a.ts", content: "x" }, "w1")] }, { kind: "done" }]]),
      tools: new ToolRegistry([failWrite]),
      maxTurns: 1,
    });
    const evs2 = await collect(nativeLoop.run(t2));
    expect(evs2).toContainEqual({ kind: "write", record: { path: "a.ts", ok: false, message: "Error: denied path" } });
    expect(t2.transcript[2].content).toBe("Error: denied path");
  });

  it("uses the preview category on tool.request", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("WriteFile", { path: "a.ts", content: "x" })] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([writeTool]), maxTurns: 1 });
    const evs = await collect(nativeLoop.run(t));
    expect(evs[0]).toMatchObject({ kind: "tool.request", category: "EDITS" });
  });

  it("finishes turn_limit when the model never stops calling tools", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Echo", { text: "x" })] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: 2 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "turn_limit" });
  });

  it("finishes cancelled when aborted before the turn", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = turn({ signal: ac.signal });
    const evs = await collect(nativeLoop.run(t));
    expect(evs).toEqual([{ kind: "finished", reason: "cancelled" }]);
  });

  it("finishes cancelled when the stream aborts", async () => {
    const ac = new AbortController();
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        ac.abort();
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    };
    const t = turn({ channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }), signal: ac.signal });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "cancelled" });
  });

  it("finishes error on a channel failure", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        throw new Error("provider down");
      },
    };
    const t = turn({ channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }) });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toMatchObject({ kind: "finished", reason: "error", error: "provider down" });
  });

  it("marks skipped calls as not executed after cancel", async () => {
    const ac = new AbortController();
    const cancelTool: Tool = {
      spec: { name: "Cancel", description: "aborts", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: false,
      execute: async () => {
        ac.abort();
        return "ok";
      },
    };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Cancel", {}, "a"), call("Echo", { text: "x" }, "b")] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([cancelTool, echoTool]), signal: ac.signal });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "cancelled" });
    expect(t.transcript[3]).toMatchObject({ role: "tool", toolCallId: "b", content: "Not executed: cancelled" });
  });
});

describe("engineFor", () => {
  it("returns native-loop for unknown channel types", () => {
    expect(engineFor("openai-compatible").id).toBe("native-loop");
    expect(engineFor("ollama").id).toBe("native-loop");
  });
  it("returns claude-code for claude-cli channels", () => {
    expect(engineFor("claude-cli").id).toBe("claude-code");
  });
});

describe("native-loop parallel calls", () => {
  const slowTool = (name: string, gate: { started: string[]; release: () => Promise<void> }): Tool => ({
    spec: { name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false } },
    requiresApproval: false,
    parallel: true,
    execute: async () => {
      gate.started.push(name);
      await gate.release();
      return name;
    },
  });

  it("runs consecutive parallel-flagged calls concurrently and keeps tool message order", async () => {
    const resolvers: (() => void)[] = [];
    const gate = {
      started: [] as string[],
      release: () => new Promise<void>((r) => resolvers.push(r)),
    };
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("P1", {}, "a"), call("P2", {}, "b")] }, { kind: "done" }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ]);
    const t = turn({ channel: ch, tools: new ToolRegistry([slowTool("P1", gate), slowTool("P2", gate)]) });
    const evsP = collect(nativeLoop.run(t));
    await vi.waitFor(() => expect(gate.started.sort()).toEqual(["P1", "P2"]));
    resolvers.forEach((r) => r());
    const evs = await evsP;
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    const toolMsgs = t.transcript.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(toolMsgs).toEqual(["a", "b"]);
  });

  it("keeps non-parallel calls sequential even when mixed with parallel ones", async () => {
    const order: string[] = [];
    const seq = (name: string): Tool => ({
      spec: { name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: false,
      execute: async () => {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${name}`);
        return name;
      },
    });
    const par = (name: string): Tool => ({ ...seq(name), parallel: true });
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("S1", {}, "a"), call("P1", {}, "b"), call("P2", {}, "c"), call("S2", {}, "d")] }, { kind: "done" }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ]);
    const t = turn({ channel: ch, tools: new ToolRegistry([seq("S1"), par("P1"), par("P2"), seq("S2")]) });
    await collect(nativeLoop.run(t));
    expect(order.indexOf("end:S1")).toBeLessThan(order.indexOf("start:P1"));
    expect(order.indexOf("start:P2")).toBeLessThan(order.indexOf("end:P1"));
    expect(order.indexOf("end:P2")).toBeLessThan(order.indexOf("start:S2"));
    const toolMsgs = t.transcript.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(toolMsgs).toEqual(["a", "b", "c", "d"]);
  });
});

describe("native-loop loop guard", () => {
  const failTool: Tool = {
    spec: { name: "Fail", description: "fails", parameters: { type: "object", properties: { x: { type: "string" } }, additionalProperties: false } },
    requiresApproval: false,
    execute: async () => {
      throw new Error("nope");
    },
  };

  it("warns on the second identical failure, then trips on the third", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("Fail", { x: "a" }, "c1")] }],
      [{ kind: "tool_calls", calls: [call("Fail", { x: "a" }, "c2")] }],
      [{ kind: "tool_calls", calls: [call("Fail", { x: "a" }, "c3")] }],
      [{ kind: "done" }],
    ]);
    const t = turn({ channel: ch, tools: new ToolRegistry([failTool]), maxTurns: 8 });
    const evs = await collect(nativeLoop.run(t));
    const fin = last(evs);
    expect(fin).toMatchObject({ kind: "finished", reason: "loop_guard" });
    expect((fin as { error?: string }).error).toContain("same call failed 3 times");
    expect((fin as { error?: string }).error).toContain("Fail");
    const warnings = t.transcript.filter((m) => m.role === "user" && m.content.includes("[Stewart]"));
    expect(warnings).toHaveLength(1);
  });

  it("adds the [Stewart] warning on the second identical call and keeps running", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("Echo", { text: "same" }, "c1")] }],
      [{ kind: "tool_calls", calls: [call("Echo", { text: "same" }, "c2")] }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: 8 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    const warnings = t.transcript.filter((m) => m.role === "user" && m.content.includes("was already called"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].content).toContain("One more identical call ends this run");
  });

  it("does not trip on the same tool with different args, then stops normally", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [call("Fail", { x: "a" }, "c1")] }],
      [{ kind: "tool_calls", calls: [call("Fail", { x: "b" }, "c2")] }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ]);
    const t = turn({ channel: ch, tools: new ToolRegistry([failTool]), maxTurns: 8 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
  });

  it("trips after 6 consecutive turns where every call fails", async () => {
    const turns = Array.from({ length: 6 }, (_, i) => [{ kind: "tool_calls" as const, calls: [call("Fail", { x: String(i) }, `c${i}`)] }]);
    turns.push([{ kind: "done" }]);
    const ch = fakeChannel(turns);
    const t = turn({ channel: ch, tools: new ToolRegistry([failTool]), maxTurns: 10 });
    const evs = await collect(nativeLoop.run(t));
    const fin = last(evs);
    expect(fin).toMatchObject({ kind: "finished", reason: "loop_guard" });
    expect((fin as { error?: string }).error).toContain("6 consecutive");
  });

  it("resets the failure streak on a successful call", async () => {
    const okTool: Tool = { ...echoTool };
    const turns = [
      ...Array.from({ length: 5 }, (_, i) => [{ kind: "tool_calls" as const, calls: [call("Fail", { x: String(i) }, `f${i}`)] }]),
      [{ kind: "tool_calls" as const, calls: [call("Echo", { text: "ok" }, "e1")] }],
      ...Array.from({ length: 5 }, (_, i) => [{ kind: "tool_calls" as const, calls: [call("Fail", { x: `g${i}` }, `g${i}`)] }]),
      [{ kind: "text" as const, text: "end" }, { kind: "done" as const }],
    ];
    const ch = fakeChannel(turns);
    const t = turn({ channel: ch, tools: new ToolRegistry([failTool, okTool]), maxTurns: 20 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
  });

  it("invalid calls count toward the streak but not the same-call rule", async () => {
    const turns = Array.from({ length: 6 }, (_, i) => [{ kind: "tool_calls" as const, calls: [call("Nope", { i }, `n${i}`)] }]);
    turns.push([{ kind: "done" }]);
    const ch = fakeChannel(turns);
    const t = turn({ channel: ch, tools: new ToolRegistry([]), maxTurns: 10 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toMatchObject({ kind: "finished", reason: "loop_guard" });
  });
});

describe("nativeLoop tool timeout", () => {
  function slowTool(over: Partial<Tool>): { tool: Tool; finish: () => void } {
    let finish = () => {};
    const tool: Tool = {
      spec: { name: "Slow", description: "slow", parameters: { type: "object", properties: {}, additionalProperties: false } },
      requiresApproval: false,
      execute: () => new Promise<string>((r) => (finish = () => r("slow done"))),
      ...over,
    };
    return { tool, finish: () => finish() };
  }
  const twoTurns = () => fakeChannel([[{ kind: "tool_calls", calls: [call("Slow")] }, { kind: "done" }], [{ kind: "text", text: "ok" }, { kind: "done" }]]);

  it("cuts off an ordinary tool after 120 s", async () => {
    vi.useFakeTimers();
    try {
      const { tool } = slowTool({});
      const t = turn({ channel: twoTurns(), tools: new ToolRegistry([tool]) });
      const p = collect(nativeLoop.run(t));
      await vi.advanceTimersByTimeAsync(121_000);
      const evs = await p;
      expect(evs.find((e) => e.kind === "tool.outcome")).toMatchObject({ ok: false });
      expect(t.transcript.find((m) => m.role === "tool")?.content).toContain("timed out after 120s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never times out a noTimeout tool (delegate, milestone checks)", async () => {
    vi.useFakeTimers();
    try {
      const s = slowTool({ noTimeout: true });
      const t = turn({ channel: twoTurns(), tools: new ToolRegistry([s.tool]) });
      const p = collect(nativeLoop.run(t));
      await vi.advanceTimersByTimeAsync(300_000);
      s.finish();
      const evs = await p;
      expect(evs.find((e) => e.kind === "tool.outcome")).toMatchObject({ ok: true });
      expect(t.transcript.find((m) => m.role === "tool")?.content).toContain("slow done");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nativeLoop beforeModelTurn", () => {
  it("is called before every model request", async () => {
    let n = 0;
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Echo", { text: "a" })] }, { kind: "done" }], [{ kind: "text", text: "ok" }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), beforeModelTurn: async () => void n++ });
    await collect(nativeLoop.run(t));
    expect(n).toBe(2);
  });
});

describe("native-loop engine contract", () => {
  it("passes the turn roleId in approve meta", async () => {
    const metas: { roleId?: string }[] = [];
    const approve: ApproveFn = async (_c, _p, meta) => {
      metas.push(meta ?? {});
      return { kind: "approved" };
    };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [call("Gate")] }], [{ kind: "text", text: "done" }, { kind: "done" }]]);
    const t = turn({ channel: ch, approve, roleId: "tester", tools: new ToolRegistry([gatedTool]) });
    const evs = await collect(nativeLoop.run(t));
    expect(metas[0]?.roleId).toBe("tester");
    expect(evs.some((e) => e.kind === "finished")).toBe(true);
  });
});

describe("native-loop turn budget", () => {
  const step = (n: number): ChatEvent[] => [{ kind: "tool_calls", calls: [call("Echo", { text: `x${n}` }, `c${n}`)] }, { kind: "done" }];

  const steps = (k: number): ChatEvent[][] => Array.from({ length: k }, (_, i) => step(i + 1));

  it("nudges before the end and keeps tools and history intact on the report-only last turn", async () => {
    const reqs: { tools: unknown[]; messages: ChatMessage[] }[] = [];
    const ch = fakeChannel([...steps(9), [{ kind: "text", text: "found it" }, { kind: "done" }]], (req) => reqs.push(req as (typeof reqs)[number]));
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: 10 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "turn_limit" });
    expect(reqs.map((r) => r.tools.length)).toEqual(Array(10).fill(1));
    const final = reqs[9].messages;
    expect(final.filter((m) => m.role === "tool")).toHaveLength(9);
    expect(final.filter((m) => m.role === "assistant" && m.toolCalls?.length)).toHaveLength(9);
    const notes = t.transcript.filter((m) => m.role === "user" && String(m.content).startsWith("[Stewart]"));
    expect(notes).toHaveLength(2);
    expect(String(notes[0].content)).toContain("3 model turns left");
    expect(String(notes[1].content)).toContain("Do not call tools");
    expect(t.transcript[t.transcript.length - 1]).toMatchObject({ role: "assistant", content: "found it" });
  });

  it("drops tool calls made on the last turn without running them, leaving a placeholder report", async () => {
    const ch = fakeChannel(steps(10));
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: 10 });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "turn_limit" });
    expect(evs.filter((e) => e.kind === "tool.outcome")).toHaveLength(9);
    const tail = t.transcript[t.transcript.length - 1];
    expect(tail).toMatchObject({ role: "assistant", content: expect.stringContaining("No report") });
    expect(tail.role === "assistant" && tail.toolCalls).toBeFalsy();
  });

  it("keeps a last turn's text when it also made tool calls", async () => {
    const ch = fakeChannel([...steps(9), [{ kind: "text", text: "the fix is X" }, { kind: "tool_calls", calls: [call("Echo", { text: "y" }, "cy")] }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: 10 });
    await collect(nativeLoop.run(t));
    expect(t.transcript[t.transcript.length - 1]).toEqual({ role: "assistant", content: "the fix is X" });
  });

  it("runs past 1000 tool turns to a normal stop when the budget is unbounded, with no budget notes", async () => {
    const ch = fakeChannel([...steps(1200), [{ kind: "text", text: "finished" }, { kind: "done" }]]);
    const t = turn({ channel: ch, tools: new ToolRegistry([echoTool]), maxTurns: Number.POSITIVE_INFINITY });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    expect(evs.filter((e) => e.kind === "tool.outcome")).toHaveLength(1200);
    expect(t.transcript.some((m) => String(m.content).startsWith("[Stewart]"))).toBe(false);
  });

  it("adds no notes below the minimum budget (bench probes, conformance)", () => {
    const t = turn({ tools: new ToolRegistry([echoTool]), maxTurns: 9 });
    expect(budgetTurn(t, 6)).toBe(false);
    expect(budgetTurn(t, 8)).toBe(false);
    expect(t.transcript).toHaveLength(1);
  });
});


describe("native-loop truncation and think", () => {
  const cut = (tokens = 9216): ChatEvent[] => [{ kind: "reasoning", text: "hmm" }, { kind: "done", usage: { in: tokens - 3000, out: 3000 }, truncated: true }];

  it("retries once with think off and a larger window when cut off before any reply", async () => {
    const reqs: { think?: boolean; minNumCtx?: number }[] = [];
    const ch = fakeChannel([cut(), [{ kind: "text", text: "report" }, { kind: "done" }]], (r) => reqs.push(r as { think?: boolean }));
    const t = turn({ channel: ch, think: true });
    const evs = await collect(nativeLoop.run(t));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ think: true });
    expect(reqs[0].minNumCtx).toBeUndefined();
    expect(reqs[1]).toMatchObject({ think: false, minNumCtx: 18432 });
    expect(t.transcript.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(t.transcript[1]).toMatchObject({ content: "report" });
  });

  it("fails with the cut-off cause when the retry is cut off too", async () => {
    const ch = fakeChannel([cut(), cut()]);
    const t = turn({ channel: ch });
    const evs = await collect(nativeLoop.run(t));
    const fin = last(evs);
    expect(fin).toMatchObject({ kind: "finished", reason: "error" });
    expect((fin as { error: string }).error).toMatch(/cut off by the context window/);
    expect(t.transcript.some((m) => m.role === "assistant")).toBe(false);
  });

  it("does not retry a truncated reply that has content, or a normal one; omits think when unset", async () => {
    const reqs: object[] = [];
    const ch = fakeChannel([[{ kind: "text", text: "partial" }, { kind: "done", truncated: true }]], (r) => reqs.push(r as object));
    const evs = await collect(nativeLoop.run(turn({ channel: ch })));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    expect(reqs).toHaveLength(1);
    expect("think" in reqs[0]).toBe(false);
  });

  it("retry floor is 8192 when the provider reported no usage", async () => {
    const reqs: { minNumCtx?: number }[] = [];
    const ch = fakeChannel([[{ kind: "done", truncated: true }], [{ kind: "text", text: "ok" }, { kind: "done" }]], (r) => reqs.push(r as object));
    await collect(nativeLoop.run(turn({ channel: ch })));
    expect(reqs[1].minNumCtx).toBe(8192);
  });

  it("passes the effective effort to the channel request", async () => {
    const reqs: { effort?: string }[] = [];
    const ch = fakeChannel([[{ kind: "text", text: "ok" }, { kind: "done" }]], (r) => reqs.push(r as { effort?: string }));
    await collect(nativeLoop.run(turn({ channel: ch, effort: "high" })));
    expect(reqs[0].effort).toBe("high");
  });

  it("drops the effort on the think:false retry (off-switch wins)", async () => {
    const reqs: { think?: boolean; effort?: string }[] = [];
    const ch = fakeChannel([cut(), [{ kind: "text", text: "report" }, { kind: "done" }]], (r) => reqs.push(r as { think?: boolean; effort?: string }));
    const evs = await collect(nativeLoop.run(turn({ channel: ch, think: true, effort: "high" })));
    expect(last(evs)).toEqual({ kind: "finished", reason: "stop" });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ think: true, effort: "high" });
    expect(reqs[1]).toMatchObject({ think: false });
    expect("effort" in reqs[1]).toBe(false);
  });
});

describe("transient provider errors", () => {
  function flaky(failures: Error[], then: ChatEvent[], seen: { n: number }, partial?: ChatEvent): ManagedChannel {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        seen.n++;
        const f = failures.shift();
        if (f) {
          if (partial) yield partial;
          throw f;
        }
        yield* then;
      },
    };
    return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
  }
  const ok: ChatEvent[] = [{ kind: "text", text: "fine" }, { kind: "done" }];
  const gw = (): Error => new ChannelError("POST /chat/completions → 504: GatewayTimeout", 504);

  it("repeats the request after a 504 and logs a retry diag", async () => {
    const seen = { n: 0 };
    const evs = await collect(nativeLoop.run(turn({ channel: flaky([gw()], ok, seen), retryDelaysMs: [0, 0] })));
    expect(seen.n).toBe(2);
    expect(evs.find((e) => e.kind === "diag" && e.tag === "retry")).toBeTruthy();
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "stop" });
  });
  it("finishes with an error once the retries are used up", async () => {
    const seen = { n: 0 };
    const evs = await collect(nativeLoop.run(turn({ channel: flaky([gw(), gw(), gw()], ok, seen), retryDelaysMs: [0, 0] })));
    expect(seen.n).toBe(3);
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "error" });
  });
  it("does not retry by default on short runs (probes, conformance): maxTurns < 10", async () => {
    const seen = { n: 0 };
    const evs = await collect(nativeLoop.run(turn({ channel: flaky([gw()], ok, seen), maxTurns: 3 })));
    expect(seen.n).toBe(1);
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "error" });
  });
  it("retries by default on full runs (maxTurns >= 10)", async () => {
    vi.useFakeTimers();
    try {
      const seen = { n: 0 };
      const p = collect(nativeLoop.run(turn({ channel: flaky([gw()], ok, seen), maxTurns: 60 })));
      await vi.advanceTimersByTimeAsync(2_000);
      const evs = await p;
      expect(seen.n).toBe(2);
      expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "stop" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not repeat a non-transient failure", async () => {
    const seen = { n: 0 };
    const bad = new ChannelError("401", 401);
    const evs = await collect(nativeLoop.run(turn({ channel: flaky([bad], ok, seen), retryDelaysMs: [0, 0] })));
    expect(seen.n).toBe(1);
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "error" });
  });
  it("does not repeat after output has started streaming", async () => {
    const seen = { n: 0 };
    const evs = await collect(nativeLoop.run(turn({ channel: flaky([gw()], ok, seen, { kind: "text", text: "par" }), retryDelaysMs: [0, 0] })));
    expect(seen.n).toBe(1);
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "error" });
  });
});

import { describe, expect, it } from "vitest";
import { ManagedChannel } from "../src/channels/registry.js";
import type { ChannelAdapter, ChatEvent, ToolCall } from "../src/channels/types.js";
import { DEFAULT_LIMITS, RunCancelledError, ToolLoop, type ApprovalDecision } from "../src/tools/toolLoop.js";
import type { ChatMessage } from "../src/channels/types.js";

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

const gatedTool = {
  spec: { name: "Gate", description: "gated", parameters: { type: "object", properties: {}, additionalProperties: false } },
  requiresApproval: true,
  preview: async () => ({ kind: "other" as const }),
  execute: async () => "done",
};

function registryOf(tools: (typeof echoTool)[]) {
  return { find: (n: string) => tools.find((t) => t.spec.name === n), tools, specs: tools.map((t) => t.spec), validate(call: ToolCall) {
    const t = this.find(call.name);
    if (!t) return `unknown tool '${call.name}'`;
    const req = (t.spec.parameters.required as string[] | undefined) ?? [];
    for (const r of req) if (!(r in call.arguments)) return `missing required argument '${r}'`;
    for (const k of Object.keys(call.arguments)) {
      if (!(k in (t.spec.parameters.properties as object))) return `unexpected argument '${k}'`;
    }
    return null;
  } };
}

const approve = async (): Promise<ApprovalDecision> => ({ kind: "approved" });
const deny = async (): Promise<ApprovalDecision> => ({ kind: "rejected", reason: "no" });
const hist: ChatMessage[] = [{ role: "user", content: "go" }];
const sig = () => new AbortController().signal;

describe("ToolLoop", () => {
  it("completes a plain text turn", async () => {
    const ch = fakeChannel([[{ kind: "text", text: "hi" }, { kind: "done" }]]);
    const loop = new ToolLoop(ch, registryOf([]) as never, approve);
    const r = await loop.run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
    expect(r.messages[0]).toMatchObject({ role: "assistant", content: "hi" });
  });

  it("runs a shim tool call and feeds the result back", async () => {
    const ch = fakeChannel([
      [{ kind: "text", text: '<tool_call>{"name":"Echo","arguments":{"text":"yo"}}</tool_call>' }, { kind: "done" }],
      [{ kind: "text", text: "final" }, { kind: "done" }],
    ]);
    const events: string[] = [];
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, DEFAULT_LIMITS, undefined, undefined, undefined, "shim");
    const r = await loop.run("m", hist, { onToolOutcome: (_c, o) => events.push(o.kind) }, sig());
    expect(r.kind).toBe("completed");
    expect(events).toEqual(["success"]);
    expect(r.messages[1]).toMatchObject({ role: "tool", content: "echo:yo" });
    expect(r.messages[2]).toMatchObject({ content: "final" });
  });

  it("reports invalid calls (unknown tool, bad args, duplicate id) back to the model", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [
        { id: "a", name: "Nope", arguments: {} },
        { id: "b", name: "Echo", arguments: {} },
        { id: "b", name: "Echo", arguments: { text: "x" } },
      ] }, { kind: "done" }],
      [{ kind: "text", text: "ok" }, { kind: "done" }],
    ]);
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, DEFAULT_LIMITS, undefined, undefined, undefined, "native");
    const r = await loop.run("m", hist, {}, sig());
    const tools = r.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools[0]).toMatch(/unknown tool/);
    expect(tools[1]).toMatch(/missing required/);
    expect(tools[2]).toMatch(/duplicate tool call id/);
  });

  it("routes approval-required tools through the gate and reports rejection", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "g", name: "Gate", arguments: {} }] }, { kind: "done" }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ]);
    const seen: ToolCall[] = [];
    const gate = async (c: ToolCall): Promise<ApprovalDecision> => {
      seen.push(c);
      return { kind: "rejected", reason: "no" };
    };
    const loop = new ToolLoop(ch, registryOf([gatedTool as never]) as never, gate, DEFAULT_LIMITS, undefined, undefined, undefined, "native");
    const r = await loop.run("m", hist, {}, sig());
    expect(seen).toHaveLength(1);
    expect(r.messages[1]).toMatchObject({ role: "tool" });
    expect(r.messages[1].content).toMatch(/Rejected by user/);
  });

  it("marks timed-out tools as uncertain", async () => {
    const slow = {
      spec: { name: "Slow", description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: () => new Promise<string>(() => {}),
    };
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "s", name: "Slow", arguments: {} }] }, { kind: "done" }],
      [{ kind: "text", text: "next" }, { kind: "done" }],
    ]);
    const loop = new ToolLoop(ch, registryOf([slow as never]) as never, approve, { ...DEFAULT_LIMITS, toolTimeoutMs: 5 }, undefined, undefined, undefined, "native");
    const r = await loop.run("m", hist, {}, sig());
    expect(r.messages[1].content).toMatch(/Outcome uncertain: timed out/);
  });

  it("throws RunCancelledError with uncertain outcome when cancelled mid-tool", async () => {
    const slow = {
      spec: { name: "Slow", description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: (_a: Record<string, unknown>, _p: unknown, s: AbortSignal) =>
        new Promise<string>((_res, rej) => s.addEventListener("abort", () => rej(new Error("abort")))),
    };
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "s", name: "Slow", arguments: {} }] }, { kind: "done" }]]);
    const ctl = new AbortController();
    const loop = new ToolLoop(ch, registryOf([slow as never]) as never, approve, DEFAULT_LIMITS, undefined, undefined, undefined, "native");
    const p = loop.run("m", hist, {}, ctl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await expect(p).rejects.toThrow(RunCancelledError);
    try {
      await p;
    } catch (e) {
      const tools = (e as RunCancelledError).produced.filter((m) => m.role === "tool");
      expect(tools[0].content).toMatch(/Outcome uncertain: cancelled/);
    }
  });

  it("stops at the turn limit", async () => {
    const ch = fakeChannel([[{ kind: "tool_calls", calls: [{ id: "e1", name: "Echo", arguments: { text: "x" } }] }, { kind: "done" }]]);
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { ...DEFAULT_LIMITS, maxModelTurns: 2 }, undefined, undefined, undefined, "native");
    const r = await loop.run("m", hist, {}, sig());
    expect(r.kind).toBe("turn_limit");
  });

  it("fails on stream without done and on post-done events", async () => {
    const ch = fakeChannel([[{ kind: "text", text: "x" }]]);
    const loop = new ToolLoop(ch, registryOf([]) as never, approve);
    const r = await loop.run("m", hist, {}, sig());
    expect(r).toMatchObject({ kind: "failed", code: "incomplete_stream" });
  });

  it("truncates oversized tool output", async () => {
    const big = {
      spec: { name: "Big", description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: async () => "x".repeat(100),
    };
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "b", name: "Big", arguments: {} }] }, { kind: "done" }],
      [{ kind: "text", text: "ok" }, { kind: "done" }],
    ]);
    const loop = new ToolLoop(ch, registryOf([big as never]) as never, approve, { ...DEFAULT_LIMITS, maxToolOutputChars: 10 }, undefined, undefined, undefined, "native");
    const r = await loop.run("m", hist, {}, sig());
    expect(r.messages[1].content).toBe("xxxxxxxxxx\n[output truncated]");
  });
});

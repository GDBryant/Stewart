import { describe, expect, it } from "vitest";
import { ManagedChannel } from "@stewart/channels";
import { type ToolCall, type ChatMessage } from "@stewart/kernel";
import type { ChannelAdapter, ChatEvent } from "@stewart/channels";
import { DEFAULT_LIMITS } from "@stewart/budget";
import type { ApprovalDecision } from "@stewart/permissions";
import { RunCancelledError, ToolLoop } from "../src/api.js";

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
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, toolsMode: "shim" });
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
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, toolsMode: "native" });
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
    const loop = new ToolLoop(ch, registryOf([gatedTool as never]) as never, gate, { limits: DEFAULT_LIMITS, toolsMode: "native" });
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
    const loop = new ToolLoop(ch, registryOf([slow as never]) as never, approve, { limits: { ...DEFAULT_LIMITS, toolTimeoutMs: 5 }, toolsMode: "native" });
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
    const loop = new ToolLoop(ch, registryOf([slow as never]) as never, approve, { limits: DEFAULT_LIMITS, toolsMode: "native" });
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
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxModelTurns: 2 }, toolsMode: "native" });
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
    const loop = new ToolLoop(ch, registryOf([big as never]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxToolOutputChars: 10 }, toolsMode: "native" });
    const r = await loop.run("m", hist, {}, sig());
    expect(r.messages[1].content).toBe("xxxxxxx\n[output truncated: 90 chars omitted]\nxxx");
  });

  it("keeps the tail of oversized output so trailing errors survive", async () => {
    const big = {
      spec: { name: "Big", description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: async () => `${"x".repeat(100)}ERROR`,
    };
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "b", name: "Big", arguments: {} }] }, { kind: "done" }],
      [{ kind: "text", text: "ok" }, { kind: "done" }],
    ]);
    const loop = new ToolLoop(ch, registryOf([big as never]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxToolOutputChars: 10 }, toolsMode: "native" });
    const r = await loop.run("m", hist, {}, sig());
    expect(r.messages[1].content.endsWith("RR") || r.messages[1].content.endsWith("OR")).toBe(true);
    expect(r.messages[1].content.length).toBeLessThan(80);
  });

  it("does not truncate output within the cap", async () => {
    const small = {
      spec: { name: "Small", description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: async () => "x".repeat(10),
    };
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "b", name: "Small", arguments: {} }] }, { kind: "done" }],
      [{ kind: "text", text: "ok" }, { kind: "done" }],
    ]);
    const loop = new ToolLoop(ch, registryOf([small as never]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxToolOutputChars: 10 }, toolsMode: "native" });
    const r = await loop.run("m", hist, {}, sig());
    expect(r.messages[1].content).toBe("xxxxxxxxxx");
  });

  it("retries a truncated turn once and fails when retries are exhausted", async () => {
    const chOk = fakeChannel([
      [{ kind: "text", text: "part" }, { kind: "done", truncated: true }],
      [{ kind: "text", text: "complete" }, { kind: "done" }],
    ]);
    const loopOk = new ToolLoop(chOk, registryOf([]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxTruncationRetries: 1 } });
    const ok = await loopOk.run("m", hist, {}, sig());
    expect(ok.kind).toBe("completed");
    expect(ok.messages[0]).toMatchObject({ content: "complete" });

    const chFail = fakeChannel([
      [{ kind: "text", text: "part1" }, { kind: "done", truncated: true }],
      [{ kind: "text", text: "part2" }, { kind: "done", truncated: true }],
    ]);
    const loopFail = new ToolLoop(chFail, registryOf([]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxTruncationRetries: 1 } });
    const fail = await loopFail.run("m", hist, {}, sig());
    expect(fail).toMatchObject({ kind: "failed", code: "truncated" });
  });

  it("reports protocol_error over a truncation retry and records done usage once", async () => {
    const ch = fakeChannel([
      [
        { kind: "text", text: "part" },
        { kind: "done", truncated: true, usage: { in: 3, out: 2 }, costUsd: 0.01 },
        { kind: "text", text: "late" },
      ],
    ]);
    const usages: [unknown, unknown][] = [];
    const loop = new ToolLoop(ch, registryOf([]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxTruncationRetries: 3 } });
    const r = await loop.run("m", hist, { onUsage: (u, c) => usages.push([u, c]) }, sig());
    expect(r).toMatchObject({ kind: "failed", code: "protocol_error", message: "provider emitted events after completion" });
    expect(usages).toEqual([[{ in: 3, out: 2 }, 0.01]]);
  });

  it("feeds a parse error back, then completes on a valid terminal call", async () => {
    const ch = fakeChannel([
      [{ kind: "text", text: '<tool_call>{"name":"Echo","arguments":{oops}}</tool_call>' }, { kind: "done" }],
      [{ kind: "tool_calls", calls: [{ id: "e1", name: "Echo", arguments: { text: "ok" } }] }, { kind: "done" }],
    ]);
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(["Echo"]), toolsMode: "native" });
    const r = await loop.run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
    const toolMsgs = r.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toBe("echo:ok");
    const fbIdx = r.messages.findIndex((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Tool call not executed"));
    expect(fbIdx).toBeGreaterThanOrEqual(0);
    expect(fbIdx).toBeLessThan(r.messages.indexOf(toolMsgs[0]));
  });

  it("compacts context when approaching maxContextChars and fails if compaction cannot fit", async () => {
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "e1", name: "Echo", arguments: { text: "a".repeat(200) } }] }, { kind: "done" }],
      [{ kind: "tool_calls", calls: [{ id: "e2", name: "Echo", arguments: { text: "b".repeat(200) } }] }, { kind: "done" }],
      [{ kind: "text", text: "final" }, { kind: "done" }],
    ]);
    const compacted: [number, number][] = [];
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxContextChars: 600 }, toolsMode: "native" });
    const r = await loop.run("m", hist, { onCompacted: (b, a) => compacted.push([b, a]) }, sig());
    expect(r.kind).toBe("completed");
    expect(compacted.length).toBeGreaterThan(0);

    const chTooSmall = fakeChannel([[{ kind: "text", text: "hi" }, { kind: "done" }]]);
    const failedCompactions: string[] = [];
    const loopSmall = new ToolLoop(chTooSmall, registryOf([]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxContextChars: 1 } });
    const f = await loopSmall.run("m", [{ role: "user", content: "too long" }], { onCompactionFailed: (m) => failedCompactions.push(m) }, sig());
    expect(f).toMatchObject({ kind: "failed", code: "context_limit" });
    expect(failedCompactions).toHaveLength(1);
  });
});

describe("ToolLoop tool injection", () => {
  const sysOf = (req: unknown) => ((req as { messages: ChatMessage[] }).messages.find((m) => m.role === "system") as { content: string } | undefined)?.content;

  it("shim mode: system prompt carries the tools block with names, schema and call format", async () => {
    let req: unknown;
    const ch = fakeChannel([[{ kind: "text", text: "ok" }, { kind: "done" }]], (r) => (req = r));
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, rolePrompt: "ROLE", terminalTools: new Set(), toolsMode: "shim" });
    await loop.run("m", hist, {}, sig());
    const sys = sysOf(req) ?? "";
    expect(sys.startsWith("ROLE\n\n<tools>")).toBe(true);
    expect(sys).toContain('"name":"Echo"');
    expect(sys).toContain(JSON.stringify(echoTool.spec.parameters));
    expect(sys).toContain("<tool_call>");
    expect((req as { tools?: unknown }).tools).toBeUndefined();
  });

  it("shim mode is the default and still injects", async () => {
    let req: unknown;
    const ch = fakeChannel([[{ kind: "text", text: "ok" }, { kind: "done" }]], (r) => (req = r));
    await new ToolLoop(ch, registryOf([echoTool]) as never, approve).run("m", hist, {}, sig());
    expect(sysOf(req)).toContain("<tools>");
  });

  it("native mode: sends tools natively and injects no tools block (negative)", async () => {
    let req: unknown;
    const ch = fakeChannel([[{ kind: "text", text: "ok" }, { kind: "done" }]], (r) => (req = r));
    const loop = new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "native" });
    await loop.run("m", hist, {}, sig());
    expect((req as { tools?: unknown[] }).tools).toHaveLength(1);
    expect(sysOf(req)).toBeUndefined();
    expect(JSON.stringify((req as { messages: unknown }).messages)).not.toContain("<tools>");
  });

  it("shim mode with zero tools: no tools block and no system message (negative)", async () => {
    let req: unknown;
    const ch = fakeChannel([[{ kind: "text", text: "ok" }, { kind: "done" }]], (r) => (req = r));
    await new ToolLoop(ch, registryOf([]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "shim" }).run("m", hist, {}, sig());
    expect(sysOf(req)).toBeUndefined();
    expect((req as { messages: ChatMessage[] }).messages).toEqual(hist);
  });

  it("shim: unknown tool call is fed back as a user message and the loop continues", async () => {
    const reqs: unknown[] = [];
    const ch = fakeChannel(
      [
        [{ kind: "text", text: '<tool_call>{"name":"Nope","arguments":{}}</tool_call>' }, { kind: "done" }],
        [{ kind: "text", text: "final" }, { kind: "done" }],
      ],
      (r) => reqs.push(r),
    );
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "shim" }).run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
    expect(reqs).toHaveLength(2);
    const fed = (reqs[1] as { messages: ChatMessage[] }).messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(fed).toContain("unknown tool 'Nope'");
    expect(fed).toContain("Known tools: Echo");
    expect(r.messages.at(-1)).toMatchObject({ role: "assistant", content: "final" });
  });

  it("shim: a persistent parse error ends as turn_limit, bounded by maxModelTurns", async () => {
    const ch = fakeChannel([[{ kind: "text", text: '<|tool_call>call:Nope{x:<|"|>1<|"|>}<tool_call|>' }, { kind: "done" }]]);
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxModelTurns: 2 }, terminalTools: new Set(), toolsMode: "shim" }).run("m", hist, {}, sig());
    expect(r.kind).toBe("turn_limit");
  });

  it("shim: bare JSON call with a known name executes", async () => {
    const ch = fakeChannel([
      [{ kind: "text", text: '{"name": "Echo", "arguments": {"text": "yo"}}' }, { kind: "done" }],
      [{ kind: "text", text: "final" }, { kind: "done" }],
    ]);
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "shim" }).run("m", hist, {}, sig());
    expect(r.messages[1]).toMatchObject({ role: "tool", content: "echo:yo" });
  });

  it("shim: schema-invalid args are returned as an invalid outcome, not executed (negative)", async () => {
    const ch = fakeChannel([
      [{ kind: "text", text: '<tool_call>{"name":"Echo","arguments":{}}</tool_call>' }, { kind: "done" }],
      [{ kind: "text", text: "final" }, { kind: "done" }],
    ]);
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "shim" }).run("m", hist, {}, sig());
    expect(r.messages[1].content).toMatch(/Invalid tool call: missing required/);
  });

  it("shim: prose with an unknown bare JSON name completes without feedback (negative, no loop)", async () => {
    const reqs: unknown[] = [];
    const ch = fakeChannel([[{ kind: "text", text: 'Schema: {"name": "Nope", "arguments": {}}' }, { kind: "done" }]], (r) => reqs.push(r));
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "shim" }).run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
    expect(reqs).toHaveLength(1);
  });

  it("native: text tool call is used when no native tool_calls arrive", async () => {
    const ch = fakeChannel([
      [{ kind: "text", text: '<|tool_call>call:Echo{text:<|"|>yo<|"|>}<tool_call|>' }, { kind: "done" }],
      [{ kind: "text", text: "final" }, { kind: "done" }],
    ]);
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "native" }).run("m", hist, {}, sig());
    expect(r.messages[1]).toMatchObject({ role: "tool", content: "echo:yo" });
  });

  it("native: native tool_calls win and text calls are not executed twice (negative)", async () => {
    const outcomes: string[] = [];
    const ch = fakeChannel([
      [
        { kind: "tool_calls", calls: [{ id: "n", name: "Echo", arguments: { text: "x" } }] },
        { kind: "text", text: '<tool_call>{"name":"Echo","arguments":{"text":"y"}}</tool_call>' },
        { kind: "done" },
      ],
      [{ kind: "text", text: "final" }, { kind: "done" }],
    ]);
    await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "native" }).run("m", hist, { onToolOutcome: (_c, o) => outcomes.push(o.kind === "success" ? o.content : o.kind) }, sig());
    expect(outcomes).toEqual(["echo:x"]);
  });

  it("does not accumulate the tools block across turns and leaves history untouched", async () => {
    const reqs: unknown[] = [];
    const ch = fakeChannel(
      [
        [{ kind: "text", text: '<tool_call>{"name":"Echo","arguments":{"text":"yo"}}</tool_call>' }, { kind: "done" }],
        [{ kind: "text", text: "final" }, { kind: "done" }],
      ],
      (r) => reqs.push(r),
    );
    const base: ChatMessage[] = [{ role: "user", content: "go" }];
    const r = await new ToolLoop(ch, registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, terminalTools: new Set(), toolsMode: "shim" }).run("m", base, {}, sig());
    expect(r.kind).toBe("completed");
    expect(reqs).toHaveLength(2);
    for (const req of reqs) {
      const sys = sysOf(req) ?? "";
      expect(sys.split("<tools>").length - 1).toBe(1);
      expect((req as { messages: ChatMessage[] }).messages.filter((m) => m.role === "system")).toHaveLength(1);
    }
    expect(base).toEqual([{ role: "user", content: "go" }]);
  });
});


describe("ToolLoop summarize stage", () => {
  const turns = (n: number): ChatEvent[][] => [
    ...Array.from({ length: n }, (_, i): ChatEvent[] => [
      { kind: "tool_calls", calls: [{ id: `e${i}`, name: "Echo", arguments: { text: "x".repeat(200) } }] },
      { kind: "done" },
    ]),
    [{ kind: "text", text: "final" }, { kind: "done" }],
  ];
  const run = (max: number, n: number, summarize?: (m: ChatMessage[]) => Promise<string>, extra: Record<string, number> = {}) => {
    const compacted: [number, number][] = [];
    const seen: ChatMessage[][] = [];
    const loop = new ToolLoop(fakeChannel(turns(n), (req) => seen.push((req as { messages: ChatMessage[] }).messages)), registryOf([echoTool]) as never, approve, { limits: { ...DEFAULT_LIMITS, maxContextChars: max, ...extra }, toolsMode: "native", summarize });
    return { loop, compacted, seen, go: () => loop.run("m", [{ role: "user", content: "task" }], { onCompacted: (b, a) => compacted.push([b, a]) }, sig()) };
  };

  it("replaces the middle with the summarizer's note and completes", async () => {
    const calls: ChatMessage[][] = [];
    const t = run(1500, 8, async (m) => (calls.push(m), "Goal: x"));
    const r = await t.go();
    expect(r.kind).toBe("completed");
    expect(calls.length).toBeGreaterThan(0);
    expect(t.compacted.length).toBeGreaterThan(0);
    expect(t.seen.some((msgs) => msgs.some((m) => typeof m.content === "string" && m.content.startsWith("[summary of earlier steps]")))).toBe(true);
  });

  it("falls back to the emergency clip when the summarizer throws", async () => {
    const t = run(1500, 8, async () => {
      throw new Error("boom");
    });
    const r = await t.go();
    expect(r.kind).toBe("completed");
    expect(t.seen.some((msgs) => msgs.some((m) => typeof m.content === "string" && m.content.startsWith("[compacted")))).toBe(true);
  });

  it("never calls the summarizer below the threshold", async () => {
    let n = 0;
    const t = run(400_000, 8, async () => (n++, "note"));
    expect((await t.go()).kind).toBe("completed");
    expect(n).toBe(0);
  });

  it("summarizeAt moves the trigger: early threshold summarizes where the default does not", async () => {
    let early = 0;
    let late = 0;
    await run(6000, 8, async () => (early++, "n"), { summarizeAt: 0.25 }).go();
    await run(6000, 8, async () => (late++, "n"), { summarizeAt: 0.99 }).go();
    expect(early).toBeGreaterThan(0);
    expect(late).toBe(0);
  });

  it("without a summarizer only the clip runs", async () => {
    const t = run(1500, 8);
    expect((await t.go()).kind).toBe("completed");
    expect(t.seen.some((msgs) => msgs.some((m) => typeof m.content === "string" && m.content.startsWith("[summary")))).toBe(false);
  });
});

describe("ToolLoop live text", () => {
  it("does not stream tool_call blocks to onText in shim mode", async () => {
    const turns: ChatEvent[][] = [
      [{ kind: "text", text: "Checking <tool_" }, { kind: "text", text: 'call>{"name":"Echo","arguments":{"text":"hi"}}</tool_call>' }, { kind: "done" }],
      [{ kind: "text", text: "all done" }, { kind: "done" }],
    ];
    const shown: string[] = [];
    const loop = new ToolLoop(fakeChannel(turns), registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, toolsMode: "shim" });
    await loop.run("m", hist, { onText: (t) => shown.push(t) }, sig());
    expect(shown.join("")).toBe("Checking all done");
  });
  it("still shows call-like text that never parsed as a call", async () => {
    const turns: ChatEvent[][] = [[{ kind: "text", text: "use <call> to wrap" }, { kind: "done" }]];
    const shown: string[] = [];
    const loop = new ToolLoop(fakeChannel(turns), registryOf([echoTool]) as never, approve, { limits: DEFAULT_LIMITS, toolsMode: "shim" });
    await loop.run("m", hist, { onText: (t) => shown.push(t) }, sig());
    expect(shown.join("")).toBe("use <call> to wrap");
  });
});

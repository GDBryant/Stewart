import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { collect } from "@stewart/kernel";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { nativeLoop, type EngineTurn } from "../src/api.js";
import { capOutput, MAX_OUTPUT_CHARS, outputCap } from "../src/outputCap.js";

const numbered = (n: number, width = 80): string => Array.from({ length: n }, (_v, i) => `${i + 1}: ${"x".repeat(width)}`).join("\n");

describe("outputCap", () => {
  it("is window × 4 × 0.08, never above 20k; 10k-ish at 32k; default window when unknown", () => {
    expect(outputCap(32_000)).toBe(10_240);
    expect(outputCap(8_000)).toBe(2_560);
    expect(outputCap(200_000)).toBe(MAX_OUTPUT_CHARS);
    expect(outputCap(65_000)).toBe(20_000);
    expect(outputCap(undefined)).toBe(10_485);
  });
});

describe("capOutput", () => {
  it("leaves results within the cap untouched", () => {
    expect(capOutput("abc", 10, "RunTerminal")).toBe("abc");
    expect(capOutput("x".repeat(10), 10, "ReadFile")).toBe("x".repeat(10));
  });

  it("other tools keep 70% head + 30% tail around an omission note", () => {
    const raw = `${"h".repeat(500)}${"m".repeat(500)}${"t".repeat(500)}`;
    const out = capOutput(raw, 1000, "RunTerminal");
    expect(out.startsWith(`${"h".repeat(500)}${"m".repeat(200)}\n`)).toBe(true);
    expect(out.endsWith("t".repeat(300))).toBe(true);
    expect(out).toContain("[output truncated: 500 chars omitted]");
  });

  it("ReadFile keeps a head window on a whole line and says where to continue", () => {
    const raw = numbered(400);
    const out = capOutput(raw, 10_240, "ReadFile");
    const lines = out.split("\n");
    const note = lines.pop()!;
    expect(note).toMatch(/^\[truncated at line \d+ of 400: \d+ chars omitted; use start_line\/end_line to read ranges \(next: start_line=\d+\)\]$/);
    const shown = Number(/at line (\d+)/.exec(note)![1]);
    expect(lines.at(-1)).toMatch(new RegExp(`^${shown}: x+$`)); // ends on a complete line
    expect(note).toContain(`start_line=${shown + 1}`);
    expect(out.length).toBeLessThanOrEqual(10_240 + 200);
    expect(out).not.toContain("output truncated"); // not the 70/30 form
  });

  it("ReadFile without numbered lines still gets a head and a generic note; Read alias counts as ReadFile", () => {
    const out = capOutput("y".repeat(5000), 1000, "Read");
    expect(out.startsWith("y".repeat(1000))).toBe(true);
    expect(out).toContain("[truncated: 4000 chars omitted; use start_line/end_line to read ranges]");
  });
});

const bigTool = (name: string, body: string): Tool => ({
  spec: { name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false } },
  requiresApproval: false,
  execute: async () => body,
});

function loopTurn(tools: Tool[], window: number | undefined, sink: { result?: string }): EngineTurn {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      const tool = req.messages.filter((m) => m.role === "tool").at(-1);
      if (tool) sink.result = tool.content;
      const evs: ChatEvent[] = i++ === 0 ? [{ kind: "tool_calls", calls: [{ id: "1", name: tools[0].spec.name, arguments: {} }] }, { kind: "done" }] : [{ kind: "text", text: "ok" }, { kind: "done" }];
      for (const e of evs) yield e;
    },
  };
  return {
    sessionId: "s",
    transcript: [{ role: "user", content: "go" }],
    system: "",
    agent: { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef,
    channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }),
    roleId: "lead",
    tools: new ToolRegistry(tools),
    approve: async () => ({ kind: "approved" }),
    state: {},
    cwd: "/p",
    signal: new AbortController().signal,
    maxTurns: 4,
    ...(window !== undefined ? { window } : {}),
  };
}

describe("native loop applies the window-aware cap", () => {
  it("a 32k window caps a 15k-char result near 10k; a 200k window leaves it; unknown window uses the 32k default", async () => {
    const raw = "z".repeat(15_000);
    const small: { result?: string } = {};
    await collect(nativeLoop.run(loopTurn([bigTool("RunTerminal", raw)], 32_000, small)));
    expect(small.result!.length).toBeLessThan(10_400);
    expect(small.result).toContain("output truncated");
    const wide: { result?: string } = {};
    await collect(nativeLoop.run(loopTurn([bigTool("RunTerminal", raw)], 200_000, wide)));
    expect(wide.result).toBe(raw);
    const unknown: { result?: string } = {};
    await collect(nativeLoop.run(loopTurn([bigTool("RunTerminal", raw)], undefined, unknown)));
    expect(unknown.result!.length).toBeLessThan(10_700);
  });

  it("a big ReadFile result gets the head window and the range note", async () => {
    const sink: { result?: string } = {};
    await collect(nativeLoop.run(loopTurn([bigTool("ReadFile", numbered(500))], 32_000, sink)));
    expect(sink.result).toMatch(/\[truncated at line \d+ of 500:.*start_line=\d+\)\]$/);
  });
});

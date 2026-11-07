import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@stewart/kernel";
import { actionsSoFar, classifyFault, countToolCalls, detectStuck } from "../src/api.js";

describe("classifyFault", () => {
  it("maps recoverable faults and ignores the rest", () => {
    const base: ChatMessage[] = [];
    expect(classifyFault({ kind: "completed", messages: [], base })).toBeUndefined();
    expect(classifyFault({ kind: "turn_limit", messages: [], base })).toBe("turn_limit");
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x", code: "truncated" })).toBe("truncated");
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x", code: "incomplete_stream" })).toBe("incomplete_stream");
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x", code: "auth" })).toBeUndefined();
    expect(classifyFault({ kind: "failed", messages: [], base, message: "x" })).toBeUndefined();
  });
});

describe("detectStuck", () => {
  const msgs = (entries: [string, string, string][]): ChatMessage[] =>
    entries.flatMap(([name, arg, out], i) => [
      { role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name, arguments: { path: arg } }] } as ChatMessage,
      { role: "tool", toolCallId: `c${i}`, content: out } as ChatMessage,
    ]);

  it("flags 3+ identical calls", () => {
    const m = msgs([
      ["ReadFile", "a.ts", "ok"],
      ["ReadFile", "a.ts", "ok"],
      ["ReadFile", "a.ts", "ok"],
    ]);
    expect(detectStuck(m).stuck).toBe(true);
  });

  it("flags 5 turns without a successful progress call", () => {
    const m = msgs(Array.from({ length: 5 }, (_, i) => ["ReadFile", `f${i}.ts`, "ok"] as [string, string, string]));
    expect(detectStuck(m).stuck).toBe(true);
  });

  it("is not stuck on normal progress or fewer than 5 idle turns", () => {
    const progress = msgs([
      ["ReadFile", "a.ts", "ok"],
      ["WriteFile", "b.ts", "wrote"],
      ["ReadFile", "c.ts", "ok"],
      ["ReadFile", "d.ts", "ok"],
      ["ReadFile", "e.ts", "ok"],
    ]);
    expect(detectStuck(progress).stuck).toBe(false);
    const short = msgs([
      ["ReadFile", "a.ts", "ok"],
      ["ReadFile", "b.ts", "ok"],
    ]);
    expect(detectStuck(short).stuck).toBe(false);
  });
});

describe("actionsSoFar and countToolCalls", () => {
  it("lists successful calls only, capped", () => {
    const m: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "WriteFile", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", content: "wrote a.ts" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "ReadFile", arguments: { path: "b.ts" } }] },
      { role: "tool", toolCallId: "c2", content: "Error: missing" },
    ];
    expect(actionsSoFar(m, 20)).toEqual(["WriteFile a.ts"]);
    expect(countToolCalls(m)).toBe(2);
  });
});

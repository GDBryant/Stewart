import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/channels/types.js";
import { compactIfOver, measureMessages, pruneStale } from "../src/tools/compaction.js";

const msg = (role: "assistant" | "tool" | "user", n: number): ChatMessage => ({ role, content: "x".repeat(n) }) as ChatMessage;

describe("compactIfOver", () => {
  it("leaves messages alone under the limit", () => {
    const produced = [msg("assistant", 10), msg("tool", 10), msg("assistant", 10)];
    const hooks = { onCompacted: () => { throw new Error("no"); }, onCompactionFailed: () => { throw new Error("no"); } };
    expect(compactIfOver([], produced, 1000, hooks)).toBe(false);
    expect(produced).toHaveLength(3);
  });

  it("clips older messages to a note, keeps the last two, and reports tokens", () => {
    const produced = [msg("assistant", 500), msg("tool", 500), msg("assistant", 20), msg("tool", 20)];
    let seen: [number, number] | undefined;
    expect(compactIfOver([], produced, 600, { onCompacted: (b, a) => (seen = [b, a]) })).toBe(false);
    expect(produced).toHaveLength(3);
    expect((produced[0] as { content: string }).content.startsWith("[compacted:")).toBe(true);
    expect(seen![1]).toBeLessThan(seen![0]);
  });

  it("fails when still over the limit and never compacts two or fewer messages", () => {
    const produced = [msg("assistant", 900), msg("tool", 900)];
    let failed = "";
    expect(compactIfOver([], produced, 100, { onCompactionFailed: (m) => (failed = m) })).toBe(true);
    expect(failed).toMatch(/context size/);
    expect(produced).toHaveLength(2);
    expect(measureMessages(produced)).toBe(1800);
  });
});

describe("pruneStale", () => {
  const call = (id: string, path: string): ChatMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name: "ReadFile", arguments: { path } }] }) as ChatMessage;
  const res = (id: string, n: number): ChatMessage => ({ role: "tool", toolCallId: id, content: "y".repeat(n) }) as ChatMessage;
  const filler = (): ChatMessage[] => [msg("assistant", 5), msg("user", 5), msg("assistant", 5), msg("user", 5)];

  it("stubs superseded and stale results, keeps call/result pairing", () => {
    const m = [call("a", "x.ts"), res("a", 900), call("b", "x.ts"), res("b", 900), ...filler()];
    expect(pruneStale(m)).toBe(2);
    expect((m[1] as { content: string }).content).toMatch(/^\[elided: ReadFile:x\.ts 900 chars/);
    expect(m[1]).toMatchObject({ role: "tool", toolCallId: "a" });
    expect(m).toHaveLength(8);
  });

  it("keeps the latest read of a path when it is inside the tail", () => {
    const m = [call("a", "x.ts"), res("a", 900), ...filler(), call("b", "x.ts"), res("b", 900)];
    pruneStale(m);
    expect((m[1] as { content: string }).content).toMatch(/^\[elided/);
    expect((m[m.length - 1] as { content: string }).content).toHaveLength(900);
  });

  it("leaves small results, the recent tail and unmatched results alone", () => {
    const m = [call("a", "x.ts"), res("a", 100), res("zz", 900), call("b", "y.ts"), res("b", 900)];
    expect(pruneStale(m)).toBe(0);
    expect((m[4] as { content: string }).content).toHaveLength(900);
  });
});

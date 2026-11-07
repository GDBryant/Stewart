import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@stewart/kernel";
import { compactIfOver, measureMessages, pruneStale, splitForSummary, summarizeMiddle } from "../src/tools/compaction.js";

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

describe("summarizeMiddle", () => {
  const u = (content: string): ChatMessage => ({ role: "user", content }) as ChatMessage;
  const a = (content: string): ChatMessage => ({ role: "assistant", content }) as ChatMessage;
  const call = (id: string): ChatMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name: "ReadFile", arguments: { path: id } }] }) as ChatMessage;
  const t = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content }) as ChatMessage;
  // 12 messages: head = 0..5 (pinned user "task" at 0), tail = 6..11.
  const transcript = (): ChatMessage[] => [
    u("task"), call("a"), t("a", "r1"), a("thinking"), call("b"), t("b", "r2"),
    a("thinking2"), call("c"), t("c", "r3"), a("x"), u("next"), a("done"),
  ];

  it("keeps the pinned user message ahead of the summary note", async () => {
    const produced = transcript();
    const summarize = vi.fn(async () => "Goal: ship");
    expect(await summarizeMiddle(produced, summarize)).toBe(true);
    expect(produced[0]).toMatchObject({ role: "user", content: "task" });
    expect(produced[1]).toMatchObject({ role: "user", content: "[summary of earlier steps]\nGoal: ship" });
  });

  it("extends the tail so a tool result keeps its assistant tool-call message", () => {
    const produced = [u("task"), a("one"), u("two"), a("three"), u("four"), call("a"), t("a", "r"), a("five"), u("six"), a("seven"), u("eight"), a("nine")];
    const split = splitForSummary(produced);
    expect(split).not.toBeNull();
    expect(split!.tail[0]).toMatchObject({ role: "assistant" });
    expect((split!.tail[0] as { toolCalls?: { id: string }[] }).toolCalls?.[0]?.id).toBe("a");
    expect(split!.tail[1]).toMatchObject({ role: "tool", toolCallId: "a" });
    expect(split!.tail.some((m, i) => i === 0 && m.role === "tool")).toBe(false);
  });

  it("returns null and does not call the summarizer for a short transcript", async () => {
    const produced = transcript().slice(0, 7);
    const before = [...produced];
    expect(splitForSummary(produced)).toBeNull();
    const summarize = vi.fn(async () => "note");
    expect(await summarizeMiddle(produced, summarize)).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(produced).toEqual(before);
  });

  it("returns false and leaves produced untouched when the summarizer throws", async () => {
    const produced = transcript();
    const before = [...produced];
    expect(await summarizeMiddle(produced, async () => { throw new Error("boom"); })).toBe(false);
    expect(produced).toEqual(before);
  });

  it("returns false and leaves produced untouched when the note is blank", async () => {
    const produced = transcript();
    const before = [...produced];
    expect(await summarizeMiddle(produced, async () => "   \n ")).toBe(false);
    expect(produced).toEqual(before);
  });

  it("does not pin an earlier summary message and folds it into the middle", async () => {
    const produced = [u("task"), a("one"), a("two"), u("[summary of earlier steps]\nold"), a("three"), a("four"), call("a"), t("a", "r"), a("five"), u("six"), a("seven"), a("eight")];
    const split = splitForSummary(produced);
    expect(split!.pinned).toEqual([produced[0]]);
    expect(split!.middle.some((m) => m.content === "[summary of earlier steps]\nold")).toBe(true);

    const summarize = vi.fn(async (_middle: ChatMessage[]) => "fresh");
    expect(await summarizeMiddle(produced, summarize)).toBe(true);
    expect(produced[0]).toMatchObject({ content: "task" });
    expect(produced[1]).toMatchObject({ content: "[summary of earlier steps]\nfresh" });
    expect(produced.some((m) => typeof m.content === "string" && m.content.includes("old"))).toBe(false);
    const passed = summarize.mock.calls[0]![0];
    expect(passed.some((m) => m.content === "[summary of earlier steps]\nold")).toBe(true);
  });

  it("replaces the middle with the note on success and hands the middle to the summarizer", async () => {
    const produced = transcript();
    const summarize = vi.fn(async (_middle: ChatMessage[]) => "  Goal: ship  ");
    expect(await summarizeMiddle(produced, summarize)).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    const passed = summarize.mock.calls[0]![0];
    expect(passed.map((m) => m.content)).toEqual(["", "r1", "thinking", "", "r2"]);
    expect(produced).toHaveLength(8);
    expect(produced[1]).toMatchObject({ content: "[summary of earlier steps]\nGoal: ship" });
    expect(produced[produced.length - 1]).toMatchObject({ role: "assistant", content: "done" });
  });
});

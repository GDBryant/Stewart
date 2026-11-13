import { describe, expect, it } from "vitest";
import { fakeHost, type ChatMessage } from "@stewart/kernel";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { compactTranscript, cutIndex, estimateTokens, expandArchived, SUMMARY_PREFIX, tailIndex } from "../src/compact.js";

const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };

function channel(reply: ChatEvent[] | Error, seen: { system?: string; user?: string } = {}): ManagedChannel {
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      seen.system = req.messages[0].content;
      seen.user = req.messages[1].content;
      if (reply instanceof Error) throw reply;
      for (const ev of reply) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

const big = "x".repeat(4000);
function long(): ChatMessage[] {
  return [
    { role: "user", content: "first goal" },
    { role: "assistant", content: big, toolCalls: [{ id: "1", name: "ReadFile", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "1", content: big },
    { role: "user", content: "second" },
    { role: "assistant", content: big },
    { role: "user", content: "third: open task" },
    { role: "assistant", content: "working" },
  ];
}

const args = (t: ChatMessage[], ch: ManagedChannel, over: object = {}) => {
  const { host, files } = fakeHost();
  return { a: { host, transcript: t, channel: ch, agent, window: 4000, archivePath: "s/x.archive.jsonl", signal: new AbortController().signal, ...over }, files };
};

describe("cutIndex / estimateTokens", () => {
  it("cuts at the second-last user message and ignores image carriers", () => {
    expect(cutIndex(long())).toBe(3);
    expect(cutIndex([{ role: "user", content: "only" }, { role: "assistant", content: "a" }])).toBe(-1);
    const t = long();
    t.splice(6, 0, { role: "user", content: "[image from ReadImage]", images: ["d"] });
    expect(cutIndex(t)).toBe(3);
  });
  it("estimates ~4 chars per token including tool calls", () => {
    expect(estimateTokens([{ role: "user", content: "abcdefgh" }])).toBe(2);
    expect(estimateTokens([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "X", arguments: {} }] }])).toBeGreaterThan(0);
  });
});

describe("compactTranscript", () => {
  it("replaces older turns with a summary, keeps the last two user turns, archives the rest", async () => {
    const seen: { system?: string; user?: string } = {};
    const t = long();
    const { a, files } = args(t, channel([{ kind: "text", text: "goals: X; changed a.ts" }, { kind: "done" }], seen), { chunkId: "k1" });
    expect(await compactTranscript(a)).toBe(true);
    expect(t).toHaveLength(5);
    expect(t[0]).toEqual({ role: "user", content: `${SUMMARY_PREFIX} #k1\ngoals: X; changed a.ts` });
    expect(t[1]).toEqual({ role: "user", content: "second" });
    expect(t[4]).toEqual({ role: "assistant", content: "working" });
    expect(seen.system).toContain("Summarise");
    expect(seen.user).toContain("first goal");
    expect(seen.user).not.toContain("third: open task");
    expect(files["s/x.archive.jsonl"].trim().split("\n")).toHaveLength(3);
  });
  it("does nothing under the threshold, with nothing older, or with the default window when unknown", async () => {
    const short: ChatMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
    expect(await compactTranscript(args(short, channel([])).a)).toBe(false);
    expect(await compactTranscript(args(long(), channel([]), { window: 1_000_000 }).a)).toBe(false);
    const one: ChatMessage[] = [{ role: "user", content: big.repeat(10) }, { role: "assistant", content: "a" }];
    expect(await compactTranscript(args(one, channel([])).a)).toBe(false);
    expect(await compactTranscript(args(long(), channel([{ kind: "text", text: "s" }, { kind: "done" }]), { window: undefined }).a)).toBe(false);
  });
  it("leaves the transcript untouched when the summary fails or is empty", async () => {
    for (const ch of [channel(new Error("down")), channel([{ kind: "text", text: "  " }, { kind: "done" }])]) {
      const t = long();
      expect(await compactTranscript(args(t, ch).a)).toBe(false);
      expect(t).toHaveLength(7);
    }
  });
});

/** One long open turn: task, then many assistant/tool pairs. */
function longTurn(pairs: number): ChatMessage[] {
  const t: ChatMessage[] = [{ role: "user", content: "build the feature" }];
  for (let i = 0; i < pairs; i++) {
    t.push({ role: "assistant", content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: "ReadFile", arguments: { path: `f${i}` } }] });
    t.push({ role: "tool", toolCallId: `c${i}`, content: big });
  }
  return t;
}

describe("compaction inside one long turn", () => {
  it("tailIndex keeps at most the last few messages, starting at an assistant message", () => {
    const t = longTurn(10);
    const i = tailIndex(t);
    expect(t[i].role).toBe("assistant");
    expect(t.length - i).toBeLessThanOrEqual(8);
    expect(tailIndex([{ role: "user", content: "x" }, { role: "assistant", content: "y" }])).toBe(-1);
    expect(tailIndex([{ role: "assistant", content: "y" }])).toBe(-1);
  });
  it("summarises the work between the open task and the tail; the task stays verbatim", async () => {
    const t = longTurn(10);
    const { a, files } = args(t, channel([{ kind: "text", text: "read f0..f6" }, { kind: "done" }]), { chunkId: "k2" });
    expect(await compactTranscript(a)).toBe(true);
    expect(t[0]).toEqual({ role: "user", content: "build the feature" });
    expect(t[1].content).toBe(`${SUMMARY_PREFIX} #k2\nread f0..f6`);
    expect(t[2].role).toBe("assistant");
    expect(files["s/x.archive.jsonl"]).toContain('"chunk":"k2"');
  });
  it("does not compact inside a turn when the tail alone is most of the transcript", async () => {
    const t: ChatMessage[] = [{ role: "user", content: "task" }, { role: "assistant", content: "a" }, { role: "tool", toolCallId: "x", content: "small" }];
    for (let i = 0; i < 3; i++) {
      t.push({ role: "assistant", content: `s${i}`, toolCalls: [{ id: `c${i}`, name: "ReadFile", arguments: {} }] });
      t.push({ role: "tool", toolCallId: `c${i}`, content: big.repeat(4) });
    }
    const { a } = args(t, channel([{ kind: "text", text: "s" }, { kind: "done" }]));
    expect(await compactTranscript(a)).toBe(false);
  });
  it("expandArchived restores the full transcript in order, nested chunks included", async () => {
    const original = longTurn(10);
    const t = [...original];
    const { a } = args(t, channel([{ kind: "text", text: "s1" }, { kind: "done" }]), { chunkId: "k3" });
    expect(await compactTranscript(a)).toBe(true);
    const full = await expandArchived(a.host, t, a.archivePath);
    expect(full).toEqual(original);
    expect(await expandArchived(a.host, t, "missing.jsonl")).toBe(t);
  });
  it("skips torn archive lines", async () => {
    const { host, files } = fakeHost();
    files["a.jsonl"] = 'not json\n{"chunk":"z","message":{"role":"user","content":"old"}}\n{}\n';
    const t: ChatMessage[] = [{ role: "user", content: `${SUMMARY_PREFIX} #z\nsum` }, { role: "user", content: "now" }];
    expect(await expandArchived(host, t, "a.jsonl")).toEqual([{ role: "user", content: "old" }, { role: "user", content: "now" }]);
  });
});

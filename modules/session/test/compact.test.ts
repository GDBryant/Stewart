import { describe, expect, it } from "vitest";
import { fakeHost, type ChatMessage } from "@stewart/kernel";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { compactTranscript, cutIndex, estimateTokens, SUMMARY_PREFIX } from "../src/compact.js";

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
    const { a, files } = args(t, channel([{ kind: "text", text: "goals: X; changed a.ts" }, { kind: "done" }], seen));
    expect(await compactTranscript(a)).toBe(true);
    expect(t).toHaveLength(5);
    expect(t[0]).toEqual({ role: "user", content: `${SUMMARY_PREFIX}\ngoals: X; changed a.ts` });
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
    const one: ChatMessage[] = [{ role: "user", content: big.repeat(10) }];
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

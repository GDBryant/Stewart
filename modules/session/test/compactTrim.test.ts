import { describe, expect, it } from "vitest";
import { fakeHost, type ChatMessage } from "@stewart/kernel";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { compactTranscript, currentTokens, estimateTokens, expandArchived, SUMMARY_PREFIX, type CompactState } from "../src/compact.js";
import { KEEP_RECENT, STUB_CAP, stubOf, trimOldResults } from "../src/compactTrim.js";

const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };
const big = (n: number, ch = "x") => ch.repeat(n);

function channel(reply: ChatEvent[], seen: { calls: number; user?: string; system?: string } = { calls: 0 }): ManagedChannel {
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      seen.calls++;
      seen.system = req.messages[0].content;
      seen.user = req.messages[1].content;
      for (const ev of reply) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}
const summaryReply: ChatEvent[] = [{ kind: "text", text: "summary" }, { kind: "done" }];

/** Task, then `pairs` assistant/tool pairs with `toolSize`-char results. */
function turn(pairs: number, toolSize: number, asstSize = 0): ChatMessage[] {
  const t: ChatMessage[] = [{ role: "user", content: "task" }];
  for (let i = 0; i < pairs; i++) {
    t.push({ role: "assistant", content: `s${i}${big(asstSize, "a")}`, toolCalls: [{ id: `c${i}`, name: "ReadFile", arguments: { path: `f${i}.ts` } }] });
    t.push({ role: "tool", toolCallId: `c${i}`, content: `${i}:${big(toolSize)}` });
  }
  return t;
}

const mk = (t: ChatMessage[], ch: ManagedChannel, over: object = {}) => {
  const { host, files } = fakeHost();
  return { a: { host, transcript: t, channel: ch, agent, window: 10_000, archivePath: "a.jsonl", signal: new AbortController().signal, ...over }, files };
};

describe("trimOldResults", () => {
  it("stubs old long tool results to head+tail with a marker, in place; recent and short ones stay", () => {
    const t = turn(6, 5000);
    const before = t.map((m) => m.content);
    const r = trimOldResults(t);
    const lastIdx = t.length - 1;
    expect(r.originals.length).toBeGreaterThan(0);
    expect(r.freedTokens).toBeGreaterThan(0);
    expect(t[2].content.length).toBeLessThan(STUB_CAP + 200);
    expect(t[2].content).toContain("tool result truncated");
    expect(t[2].content.startsWith("0:")).toBe(true); // head kept
    expect(t[lastIdx].content).toBe(before[lastIdx]); // within the last KEEP_RECENT messages
    expect(t.slice(-KEEP_RECENT).map((m) => m.content)).toEqual(before.slice(-KEEP_RECENT));
    expect(t[1].content).toBe(before[1]); // assistant untouched
    expect(r.originals[0].content).toBe(before[2]); // original captured
  });

  it("is idempotent, skips short results, and a second harder pass trims more", () => {
    const t = turn(6, 5000);
    trimOldResults(t);
    expect(trimOldResults(t).originals).toHaveLength(0);
    const short = turn(6, 100);
    expect(trimOldResults(short).originals).toHaveLength(0);
    const r2 = trimOldResults(t, 2, 400);
    expect(r2.originals.length).toBeGreaterThan(0);
  });

  it("stubOf keeps text within the cap untouched and the tail of longer text", () => {
    expect(stubOf("short", 100)).toBe("short");
    const s = stubOf(`${big(2000)}END`, 300);
    expect(s.endsWith("END")).toBe(true);
    expect(s).toContain("1703 chars omitted");
  });

  it("never touches non-tool messages or image carriers", () => {
    const t: ChatMessage[] = [{ role: "user", content: big(5000) }, { role: "user", content: "[image from ReadImage]", images: ["d"] }, ...turn(5, 10)];
    const before = JSON.stringify(t);
    expect(trimOldResults(t).originals).toHaveLength(0);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe("currentTokens", () => {
  it("uses the measured count plus the estimate of what was appended since", () => {
    const t = turn(2, 400);
    const appended = estimateTokens(t.slice(3));
    expect(currentTokens({ transcript: t, measured: { tokens: 9000, len: 3 } })).toBe(9000 + appended);
    expect(currentTokens({ transcript: t })).toBe(estimateTokens(t));
  });
  it("ignores a measurement that no longer fits the transcript (shrunk by compaction)", () => {
    const t = turn(1, 400);
    expect(currentTokens({ transcript: t, measured: { tokens: 9000, len: 50 } })).toBe(estimateTokens(t));
  });
});

describe("compactTranscript: trim first, then summarise", () => {
  it("a trim that gets under the threshold makes no model call and archives the originals", async () => {
    const seen = { calls: 0 };
    const t = turn(8, 3000); // ~6k tokens; trimming old results brings it under 6k (0.6 × 10k)... then under
    const { a, files } = mk(t, channel(summaryReply, seen), { window: 7000 });
    expect(await compactTranscript(a)).toBe(true);
    expect(seen.calls).toBe(0);
    expect(t.some((m) => m.content.startsWith(SUMMARY_PREFIX))).toBe(false);
    expect(files["a.jsonl"]).toContain(`${big(100)}`);
    expect(estimateTokens(t)).toBeLessThanOrEqual(4200);
  });

  it("under the threshold: nothing happens, no model call", async () => {
    const seen = { calls: 0 };
    const t = turn(3, 300);
    const { a } = mk(t, channel(summaryReply, seen));
    expect(await compactTranscript(a)).toBe(false);
    expect(seen.calls).toBe(0);
  });

  it("when trimming is not enough, summarises, and the summariser sees file paths and the Files read ask", async () => {
    const seen: { calls: number; user?: string; system?: string } = { calls: 0 };
    const t = turn(10, 3000, 3000); // assistant text is not trimmed
    const { a } = mk(t, channel(summaryReply, seen), { window: 6000, chunkId: "k" });
    expect(await compactTranscript(a)).toBe(true);
    expect(seen.calls).toBe(1);
    expect(seen.system).toContain("Files read");
    expect(seen.user).toContain("[ReadFile f0.ts]");
    expect(t[1].content).toBe(`${SUMMARY_PREFIX} #k\nsummary`);
  });

  it("a measured prompt over the limit triggers compaction the estimate alone would miss", async () => {
    const seen = { calls: 0 };
    const t = turn(8, 2000); // estimate ≈ 4.2k tokens; window 8000 → limit 4800
    const { a } = mk(t, channel(summaryReply, seen), { window: 8000 });
    expect(await compactTranscript({ ...a, transcript: t })).toBe(false);
    const t2 = turn(8, 2000);
    const m = mk(t2, channel(summaryReply, seen), { window: 8000, measured: { tokens: 6000, len: t2.length } });
    await compactTranscript(m.a);
    expect(t2.some((x) => x.content.includes("tool result truncated") || x.content.startsWith(SUMMARY_PREFIX))).toBe(true);
  });
});

describe("cooldown and second pass", () => {
  it("no new model summary within 4 requests of the last one; allowed on the 5th", async () => {
    const seen = { calls: 0 };
    const state: CompactState = { sinceSummary: 100 };
    const run = async () => {
      const t = turn(10, 200, 1500); // ≈ 4k tokens: over the 3.6k limit, under 90% of the window
      return compactTranscript(mk(t, channel(summaryReply, seen), { window: 6000, state }).a);
    };
    expect(await run()).toBe(true);
    expect(seen.calls).toBe(1);
    expect(state.sinceSummary).toBe(0);
    for (let i = 0; i < 4; i++) await run();
    expect(seen.calls).toBe(1); // cooled down for 4 requests
    await run();
    expect(seen.calls).toBe(2);
  });

  it("cooldown is overridden when the prompt passes 90% of the window", async () => {
    const seen = { calls: 0 };
    const state: CompactState = { sinceSummary: 0 };
    const t = turn(10, 200, 3000); // ≈ 7.7k tokens, window 6000 → > 90%
    await compactTranscript(mk(t, channel(summaryReply, seen), { window: 6000, state }).a);
    expect(seen.calls).toBe(1);
  });

  it("a summary that leaves the transcript above the threshold is followed by a harder trim, not another model call", async () => {
    const seen = { calls: 0 };
    const t = turn(12, 4000, 1400); // the kept tail stays over the 3.6k limit after the first trim
    const { a } = mk(t, channel(summaryReply, seen), { window: 6000 });
    await compactTranscript(a);
    expect(seen.calls).toBe(1);
    expect(t[1].content.startsWith(SUMMARY_PREFIX)).toBe(true);
    const tools = t.filter((m) => m.role === "tool");
    expect(tools.at(-1)!.content.length).toBeGreaterThan(3900); // last 2 messages stay whole
    expect(tools.at(-2)!.content.length).toBeLessThan(1000); // older tail results get the harder 800-char stub
  });

  it("without a state object there is no cooldown", async () => {
    const seen = { calls: 0 };
    for (let i = 0; i < 2; i++) await compactTranscript(mk(turn(10, 200, 3000), channel(summaryReply, seen), { window: 6000 }).a);
    expect(seen.calls).toBe(2);
  });

  it("a failed archive during trimming leaves the transcript untouched", async () => {
    const t = turn(8, 5000);
    const before = JSON.stringify(t);
    const { a } = mk(t, channel(summaryReply), { window: 6000 });
    a.host.files.appendLine = async () => {
      throw new Error("disk full");
    };
    await compactTranscript({ ...a, channel: channel([{ kind: "done" }]) });
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe("expandArchived restores trimmed originals", () => {
  it("puts each trimmed tool result back, also inside an expanded summary chunk; the live transcript is untouched", async () => {
    const t = turn(10, 3000, 3000);
    const originals = t.filter((m) => m.role === "tool").map((m) => m.content);
    const { a, files } = mk(t, channel(summaryReply), { window: 6000, chunkId: "k" });
    await compactTranscript(a);
    expect(t.some((m) => m.content.includes("tool result truncated"))).toBe(true);
    const live = JSON.stringify(t);
    const { host } = fakeHost();
    const full = await expandArchived({ ...host, files: { ...host.files, exists: async () => true, readLines: async () => files["a.jsonl"].trim().split("\n") } }, t, "a.jsonl");
    expect(JSON.stringify(t)).toBe(live);
    const tools = full.filter((m) => m.role === "tool").map((m) => m.content);
    expect(tools).toEqual(originals);
    expect(full.some((m) => m.content.includes("tool result truncated"))).toBe(false);
  });

  it("a stub with no archived original (or a different head) stays as it is; torn lines are skipped", async () => {
    const stub = { role: "tool" as const, toolCallId: "c1", content: "head\n[Stewart: tool result truncated, 9 chars omitted]\ntail" };
    const lines = ["not json", JSON.stringify({ chunk: "t1", trimmed: true, message: { role: "tool", toolCallId: "c1", content: "other head ......" } })];
    const { host } = fakeHost();
    const files = { ...host.files, exists: async () => true, readLines: async () => lines };
    const out = await expandArchived({ ...host, files }, [stub], "a.jsonl");
    expect(out[0]).toBe(stub);
  });
});

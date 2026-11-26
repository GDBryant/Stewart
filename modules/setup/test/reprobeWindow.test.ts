import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChatEvent } from "@stewart/channels";
import type { ChannelDef } from "@stewart/config";
import { LARGE_PROBE_CHARS, LARGE_WINDOW, needsLargeProbe, probeMessage, reprobeWindow, windowProbe } from "../src/conformanceShared.js";

const ch = (caps: Record<string, unknown>): ChannelDef =>
  ({ id: "c", type: "openai-compatible", enabled: true, discoverModels: true, extraModels: [], modelCaps: { m: caps } }) as unknown as ChannelDef;
const floor = { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } };

function channelWith(events: ChatEvent[], seen: { len: number } = { len: 0 }): ManagedChannel {
  return new ManagedChannel(
    {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* (_c, _s, req) {
        seen.len = String(req.messages[0]?.content ?? "").length;
        for (const e of events) yield e;
      },
    },
    { id: "c", type: "fake", enabled: true, maxParallel: 1 },
  );
}

describe("needsLargeProbe", () => {
  it("is true only for a probe-floor window with no provider-reported one", () => {
    expect(needsLargeProbe(ch(floor), "m")).toBe(true);
    expect(needsLargeProbe(ch({ ...floor, contextTokens: 131072 }), "m")).toBe(false);
    expect(needsLargeProbe(ch({ qualified: { agent: { passed: true, at: 1, version: 2, context: 64000 } } }), "m")).toBe(false);
    expect(needsLargeProbe(ch({}), "m")).toBe(false);
  });
});

describe("reprobeWindow", () => {
  it("sends the large message and returns the larger window on a pass", async () => {
    const seen = { len: 0 };
    const mc = channelWith([{ kind: "text", text: "quillfeather" }, { kind: "done", usage: { in: 62000, out: 3 } }], seen);
    expect(await reprobeWindow(ch(floor), "m", mc)).toBe(LARGE_WINDOW);
    expect(seen.len).toBeGreaterThanOrEqual(LARGE_PROBE_CHARS);
  });

  it("fails when the provider evaluated fewer tokens than sent, the word is missing, or the reply is truncated", async () => {
    const low = channelWith([{ kind: "text", text: "quillfeather" }, { kind: "done", usage: { in: 32000, out: 1 } }]);
    expect(await reprobeWindow(ch(floor), "m", low)).toBeUndefined();
    const miss = channelWith([{ kind: "text", text: "nope" }, { kind: "done" }]);
    expect(await reprobeWindow(ch(floor), "m", miss)).toBeUndefined();
    const trunc = channelWith([{ kind: "text", text: "quillfeather" }, { kind: "done", truncated: true }]);
    expect(await reprobeWindow(ch(floor), "m", trunc)).toBeUndefined();
  });

  it("uses an injected transport and keeps the 28k probe unchanged", async () => {
    expect(await reprobeWindow(ch(floor), "m", channelWith([]), async () => ({ text: "quillfeather" }))).toBe(LARGE_WINDOW);
    expect(await windowProbe(async () => ({ text: "quillfeather", usageIn: 25000 }))).toBeUndefined();
    expect(probeMessage().length).toBeLessThan(LARGE_PROBE_CHARS);
  });
});

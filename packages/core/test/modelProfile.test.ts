import { describe, expect, it } from "vitest";
import { profileFromChannel, resolveModelProfile, type PriceMap } from "../src/modelProfile.js";
import type { ModelPerf } from "../src/channels/types.js";

const perf: ModelPerf = { benchedAt: 1, benchVersion: 1, tokPerSec: 50 };
const cfg = (type: string, modelCaps?: Record<string, object>) => ({ type, modelCaps: modelCaps as never });
const UNKNOWN = "zz-no-such-model-xyz";

describe("profileFromChannel", () => {
  it("surfaces user modelCaps in caps and perf", () => {
    const p = profileFromChannel(cfg("openai-compatible", { m: { vision: true, tools: "native", perf } }), { channel: "c", model: "m" });
    expect(p.caps.vision).toBe(true);
    expect(p.caps.tools).toBe("native");
    expect(p.perf?.tokPerSec).toBe(50);
    expect(p.channelId).toBe("c");
    expect(p.model).toBe("m");
  });

  it("toolsMode comes from caps.tools, defaulting to DEFAULT_CAPS", () => {
    const native = profileFromChannel(cfg("x", { m: { tools: "native" } }), { channel: "c", model: "m" });
    expect(native.toolsMode).toBe("native");
    const none = profileFromChannel(cfg("x", { m: { tools: "none" } }), { channel: "c", model: "m" });
    expect(none.toolsMode).toBe("none");
    const unset = profileFromChannel(cfg("x", { m: { vision: true } }), { channel: "c", model: "m" });
    expect(unset.toolsMode).toBe("shim");
  });

  it("price precedence: agent.price beats live beats catalog", () => {
    const live: PriceMap = { "gpt-5-mini": { inPerMTok: 9, outPerMTok: 9 } };
    const ref = { channel: "c", model: "gpt-5-mini" };
    const agentWins = profileFromChannel(cfg("openai"), { ...ref, agent: { price: { inPerMTok: 1, outPerMTok: 2 } } }, live);
    expect(agentWins.price).toEqual({ inPerMTok: 1, outPerMTok: 2, source: "agent" });
    const liveWins = profileFromChannel(cfg("openai"), ref, live);
    expect(liveWins.price).toEqual({ inPerMTok: 9, outPerMTok: 9, source: "live" });
    const catalog = profileFromChannel(cfg("openai"), ref);
    expect(catalog.price).toEqual({ inPerMTok: 0.25, outPerMTok: 2, source: "catalog" });
  });

  it("derives costBlended and costTier from the resolved price", () => {
    const agent = profileFromChannel(cfg("openai"), { channel: "c", model: UNKNOWN, agent: { price: { inPerMTok: 1, outPerMTok: 1 } } });
    expect(agent.costBlended).toBe(1);
    expect(agent.costTier).toBe("mid");
    const catalog = profileFromChannel(cfg("openai"), { channel: "c", model: "gpt-5-nano" });
    expect(catalog.costBlended).toBeCloseTo(0.1375);
    expect(catalog.costTier).toBe("low");
    const high = profileFromChannel(cfg("openai"), { channel: "c", model: "gpt-5-mini" }, { "gpt-5-mini": { inPerMTok: 9, outPerMTok: 9 } });
    expect(high.costTier).toBe("high");
  });

  it("ollama channel is catalog-priced at 0 and tiered free", () => {
    const p = profileFromChannel(cfg("ollama"), { channel: "local", model: "llama3" });
    expect(p.price).toEqual({ inPerMTok: 0, outPerMTok: 0, source: "catalog" });
    expect(p.costBlended).toBe(0);
    expect(p.costTier).toBe("free");
  });

  it("unknown channel/model: empty caps, shim, no price, never 0", () => {
    const p = profileFromChannel(cfg("openai-compatible"), { channel: "c", model: UNKNOWN });
    expect(p.caps).toEqual({});
    expect(p.toolsMode).toBe("shim");
    expect(p.price).toBeUndefined();
    expect(p.costBlended).toBeUndefined();
    expect(p.costTier).toBeUndefined();
    expect(p.perf).toBeUndefined();
  });

  it("unknown channel (no config) yields the same empty profile", () => {
    const p = profileFromChannel(undefined, { channel: "missing", model: UNKNOWN });
    expect(p.caps).toEqual({});
    expect(p.toolsMode).toBe("shim");
    expect(p.price).toBeUndefined();
    expect(p.costBlended).toBeUndefined();
    expect(p.channelType).toBe("");
  });

  it("model with caps on another model does not leak", () => {
    const p = profileFromChannel(cfg("openai-compatible", { other: { vision: true } }), { channel: "c", model: UNKNOWN });
    expect(p.caps).toEqual({});
    expect(p.price).toBeUndefined();
  });
});

describe("resolveModelProfile", () => {
  it("returns the empty profile when the channel id is not configured", () => {
    const p = resolveModelProfile({ channels: [] as never[] }, { channel: "nope", model: UNKNOWN });
    expect(p.caps).toEqual({});
    expect(p.toolsMode).toBe("shim");
    expect(p.price).toBeUndefined();
    expect(p.costBlended).toBeUndefined();
  });
});

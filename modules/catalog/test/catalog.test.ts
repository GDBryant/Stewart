import { describe, expect, it } from "vitest";
import { blendedCost, costTier, lookupModelInfo, normalizeModel } from "../src/api.js";

describe("lookupModelInfo", () => {
  it("matches known models with and without a provider prefix", () => {
    expect(lookupModelInfo("openai-compatible", "gpt-5-mini")).toMatchObject({ inPerMTok: 0.25, outPerMTok: 2.0, family: "gpt-5" });
    expect(lookupModelInfo("openai-compatible", "openai/gpt-5")).toMatchObject({ inPerMTok: 1.25, tier: "flagship" });
    expect(lookupModelInfo("openai-compatible", "anthropic/claude-opus-4.5")).toMatchObject({ inPerMTok: 5 });
    expect(lookupModelInfo("openai-compatible", "Claude-Haiku-5-5")).toMatchObject({ family: "claude", tier: "small" });
  });

  it("returns undefined for unknown models and zero price for ollama", () => {
    expect(lookupModelInfo("openai-compatible", "my-fine-tune-9")).toBeUndefined();
    expect(lookupModelInfo("ollama", "qwen3:8b")).toEqual({ inPerMTok: 0, outPerMTok: 0 });
  });
});

describe("blendedCost and costTier", () => {
  it("blends 3:1 in:out and tiers by bounds", () => {
    expect(blendedCost({ inPerMTok: 4, outPerMTok: 8 })).toBe(5);
    expect(blendedCost({ inPerMTok: 2 })).toBe(2);
    expect(blendedCost(undefined)).toBeUndefined();
    expect(blendedCost({})).toBeUndefined();
    expect(costTier(0)).toBe("free");
    expect(costTier(0.49)).toBe("low");
    expect(costTier(0.5)).toBe("mid");
    expect(costTier(4.99)).toBe("mid");
    expect(costTier(5)).toBe("high");
    expect(costTier(undefined)).toBeUndefined();
  });
});

describe("normalizeModel", () => {
  it("maps spaced Claude names to the CLI alias and kebab-cases others; leaves ids alone", () => {
    expect(normalizeModel("Claude Sonnet 4.5")).toBe("sonnet");
    expect(normalizeModel("Opus 4")).toBe("opus");
    expect(normalizeModel("haiku")).toBe("haiku");
    expect(normalizeModel("My Local Model")).toBe("my-local-model");
    expect(normalizeModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });
});

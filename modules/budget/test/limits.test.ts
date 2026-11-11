import { describe, expect, it } from "vitest";
import { budgetProfile, DEFAULT_BUDGET_PROFILES, DEFAULT_MODEL_CALL_TIMEOUT_MS, effectiveRunCapMs, resolveLimits, compactionThresholds, contextCharsFor, toolOutputCap } from "../src/api.js";
import { profileFromChannel, type ModelPerf } from "@stewart/models";

const turns = (t: number | "unlimited" = 25) => (t === "unlimited" ? Number.MAX_SAFE_INTEGER : t);

const agent = (over: Record<string, unknown> = {}) => ({ id: "a", channel: "c", model: "m", effort: "medium", ...over });
const perf = (p: Partial<ModelPerf>) => ({ benchedAt: 1, benchVersion: 1, ...p });
const normal = DEFAULT_BUDGET_PROFILES.normal;
const modelFor = (p?: ModelPerf, type = "openai-compatible") =>
  profileFromChannel({ type, modelCaps: p ? { m: { perf: p } } : undefined }, { channel: "c", model: "m" });

describe("resolveLimits", () => {
  it("scales turns by profile and clamps to ceiling x multiplier", () => {
    const q = resolveLimits({ baseTurns: turns(), profile: DEFAULT_BUDGET_PROFILES.quick, ceiling: 60 });
    expect(q.maxModelTurns).toBe(10); // 25 * 0.4
    const d = resolveLimits({ baseTurns: turns(), profile: DEFAULT_BUDGET_PROFILES.deep, ceiling: 60 });
    expect(d.maxModelTurns).toBe(50); // 25 * 2
    const tiny = resolveLimits({ baseTurns: turns(200), profile: normal, ceiling: 60 });
    expect(tiny.maxModelTurns).toBe(60); // ceiling clamp
    const deepCeiling = resolveLimits({ baseTurns: turns(200), profile: DEFAULT_BUDGET_PROFILES.deep, ceiling: 60 });
    expect(deepCeiling.maxModelTurns).toBe(120); // ceiling x turnMultiplier
  });

  it("preserves unlimited turnBudget but still scales timeouts", () => {
    const l = resolveLimits({ baseTurns: turns("unlimited"), profile: DEFAULT_BUDGET_PROFILES.deep, ceiling: 60 });
    expect(l.maxModelTurns).toBe(Number.MAX_SAFE_INTEGER);
    expect(l.toolTimeoutMs).toBe(180_000); // 60s * 3
  });

  it("slow models get longer timeouts; unknown speed means factor 1", () => {
    const slow = resolveLimits({ baseTurns: turns(), agent: agent(), profile: normal, ceiling: 60, model: modelFor(perf({ tokPerSec: 10 })) });
    expect(slow.toolTimeoutMs).toBe(240_000); // 60s * 4 (clamped)
    expect(slow.modelCallTimeoutMs).toBe(4 * DEFAULT_MODEL_CALL_TIMEOUT_MS);
    const fast = resolveLimits({ baseTurns: turns(), agent: agent(), profile: normal, ceiling: 60, model: modelFor(perf({ tokPerSec: 80 })) });
    expect(fast.toolTimeoutMs).toBe(30_000);
    const unknown = resolveLimits({ baseTurns: turns(), agent: agent(), profile: normal, ceiling: 60 });
    expect(unknown.toolTimeoutMs).toBe(60_000);
  });

  it("costly agents get fewer turns; unreliable tool users get fewer", () => {
    const pricey = resolveLimits({
      baseTurns: turns(),
      agent: agent({ billing: "priced", price: { inPerMTok: 40, outPerMTok: 40 } }),
      profile: normal,
      ceiling: 60,
      model: modelFor(),
    });
    expect(pricey.maxModelTurns).toBe(13); // 25 * 0.5 (costFactor clamped)
    const flaky = resolveLimits({ baseTurns: turns(), agent: agent(), profile: normal, ceiling: 60, model: modelFor(perf({ toolReliability: 0.3 })) });
    expect(flaky.maxModelTurns).toBe(19); // 25 * 0.75
    const free = resolveLimits({
      baseTurns: turns(),
      agent: agent({ billing: "priced", price: { inPerMTok: 0.1, outPerMTok: 0.1 } }),
      profile: normal,
      ceiling: 60,
    });
    expect(free.maxModelTurns).toBe(38); // 25 * 1.5 (cheap boost clamped)
  });
  it("free agents keep factor 1; unpriced costing agents with no known price keep factor 1", () => {
    const freeAgent = resolveLimits({ baseTurns: turns(), agent: agent({ billing: "free", price: { inPerMTok: 40, outPerMTok: 40 } }), profile: normal, ceiling: 60 });
    expect(freeAgent.maxModelTurns).toBe(25);
    const fromModel = resolveLimits({ baseTurns: turns(), agent: agent({ billing: "priced" }), profile: normal, ceiling: 60, model: modelFor() });
    expect(fromModel.maxModelTurns).toBe(25);
    const noPrice = resolveLimits({ baseTurns: turns(), agent: agent({ billing: "priced" }), profile: normal, ceiling: 60 });
    expect(noPrice.maxModelTurns).toBe(25);
  });

  it("agent.budget overrides derived factors", () => {
    const l = resolveLimits({
      baseTurns: turns(),
      agent: agent({ budget: { turnFactor: 2, timeoutFactor: 0.5 } }),
      profile: normal,
      ceiling: 60,
      model: modelFor(perf({ toolReliability: 0.3 })),
    });
    expect(l.maxModelTurns).toBe(50);
    expect(l.toolTimeoutMs).toBe(30_000);
  });
});

describe("effectiveRunCapMs", () => {
  it("takes the smaller non-zero of hour ceiling and minute cap", () => {
    expect(effectiveRunCapMs(0, DEFAULT_BUDGET_PROFILES.quick)).toBe(10 * 60_000);
    expect(effectiveRunCapMs(2, DEFAULT_BUDGET_PROFILES.quick)).toBe(10 * 60_000);
    expect(effectiveRunCapMs(0.001, DEFAULT_BUDGET_PROFILES.normal)).toBe(3_600);
    expect(effectiveRunCapMs(0, DEFAULT_BUDGET_PROFILES.deep)).toBe(0);
  });
});

describe("budgetProfile", () => {
  it("returns the named profile and defaults to normal", () => {
    const settings = { budgets: { ...DEFAULT_BUDGET_PROFILES, quick: { ...DEFAULT_BUDGET_PROFILES.quick, maxRunMinutes: 5 } } };
    expect(budgetProfile(settings, "quick").maxRunMinutes).toBe(5);
    expect(budgetProfile(settings, undefined)).toEqual(DEFAULT_BUDGET_PROFILES.normal);
    expect(budgetProfile({}, "deep")).toEqual(DEFAULT_BUDGET_PROFILES.deep);
  });
});

describe("compactionThresholds", () => {
  it("quick compacts earlier than normal, deep later", () => {
    const q = compactionThresholds(DEFAULT_BUDGET_PROFILES.quick);
    const n = compactionThresholds(DEFAULT_BUDGET_PROFILES.normal);
    const d = compactionThresholds(DEFAULT_BUDGET_PROFILES.deep);
    expect(q.pruneAt).toBeLessThan(n.pruneAt);
    expect(n.pruneAt).toBeLessThan(d.pruneAt);
    expect(q.summarizeAt).toBeLessThan(n.summarizeAt);
    expect(n.summarizeAt).toBeLessThan(d.summarizeAt);
    expect(n).toEqual({ pruneAt: 0.6, summarizeAt: 0.8 });
  });
  it("is carried by resolveLimits", () => {
    expect(resolveLimits({ profile: DEFAULT_BUDGET_PROFILES.quick, ceiling: 60 })).toMatchObject({ pruneAt: 0.4, summarizeAt: 0.6 });
  });
});

describe("context cap from the model profile", () => {
  const ctx = (caps: Record<string, unknown>, type = "openai-compatible") =>
    resolveLimits({ profile: normal, ceiling: 60, model: profileFromChannel({ type, modelCaps: { m: caps } }, { channel: "c", model: "m" }) }).maxContextChars;
  it("scales a small window down", () => {
    expect(ctx({ numCtx: 8192 })).toBe(24_576);
    expect(ctx({ contextTokens: 32_000 })).toBe(96_000);
  });
  it("prefers numCtx over contextTokens", () => {
    expect(ctx({ numCtx: 8192, contextTokens: 128_000 })).toBe(24_576);
  });
  it("never exceeds the default ceiling or drops below the floor", () => {
    expect(ctx({ contextTokens: 1_000_000 })).toBe(400_000);
    expect(contextCharsFor(100)).toBe(8_000);
  });
  it("keeps the default when the window is unknown or invalid", () => {
    expect(ctx({})).toBe(400_000);
    expect(contextCharsFor(undefined)).toBe(400_000);
    expect(contextCharsFor(0)).toBe(400_000);
    expect(resolveLimits({ profile: normal, ceiling: 60 }).maxContextChars).toBe(400_000);
  });
});

describe("toolOutputCap", () => {
  it("keeps the default 20k for a full-size context and halves it for quick", () => {
    expect(toolOutputCap(400_000, DEFAULT_BUDGET_PROFILES.normal)).toBe(20_000);
    expect(toolOutputCap(400_000, DEFAULT_BUDGET_PROFILES.quick)).toBe(10_000);
  });
  it("shrinks with a small context window but never below 2k", () => {
    expect(toolOutputCap(60_000, DEFAULT_BUDGET_PROFILES.normal)).toBe(6_000);
    expect(toolOutputCap(8_000, DEFAULT_BUDGET_PROFILES.quick)).toBe(2_000);
  });
  it("never exceeds the default for deep", () => {
    expect(toolOutputCap(400_000, DEFAULT_BUDGET_PROFILES.deep)).toBe(20_000);
  });
});

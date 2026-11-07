import { describe, expect, it } from "vitest";
import { budgetProfile, DEFAULT_BUDGET_PROFILES, DEFAULT_MODEL_CALL_TIMEOUT_MS, effectiveRunCapMs, resolveLimits } from "../src/limits.js";
import type { AgentDef, RoleDef } from "../src/config/schema.js";
import { profileFromChannel } from "../src/modelProfile.js";

const role = (turnBudget: number | "unlimited" = 25): RoleDef => ({
  id: "r",
  enabled: true,
  skills: [],
  tools: [],
  writePaths: [],
  turnBudget,
});

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({ id: "a", channel: "c", model: "m", effort: "medium", ...over });
const perf = (p: Partial<import("../src/channels/types.js").ModelPerf>) => ({ benchedAt: 1, benchVersion: 1, ...p });
const normal = DEFAULT_BUDGET_PROFILES.normal;
const modelFor = (p?: import("../src/channels/types.js").ModelPerf, type = "openai-compatible") =>
  profileFromChannel({ type, modelCaps: p ? { m: { perf: p } } : undefined }, { channel: "c", model: "m" });

describe("resolveLimits", () => {
  it("scales turns by profile and clamps to ceiling x multiplier", () => {
    const q = resolveLimits({ role: role(), profile: DEFAULT_BUDGET_PROFILES.quick, ceiling: 60 });
    expect(q.maxModelTurns).toBe(10); // 25 * 0.4
    const d = resolveLimits({ role: role(), profile: DEFAULT_BUDGET_PROFILES.deep, ceiling: 60 });
    expect(d.maxModelTurns).toBe(50); // 25 * 2
    const tiny = resolveLimits({ role: role(200), profile: normal, ceiling: 60 });
    expect(tiny.maxModelTurns).toBe(60); // ceiling clamp
    const deepCeiling = resolveLimits({ role: role(200), profile: DEFAULT_BUDGET_PROFILES.deep, ceiling: 60 });
    expect(deepCeiling.maxModelTurns).toBe(120); // ceiling x turnMultiplier
  });

  it("preserves unlimited turnBudget but still scales timeouts", () => {
    const l = resolveLimits({ role: role("unlimited"), profile: DEFAULT_BUDGET_PROFILES.deep, ceiling: 60 });
    expect(l.maxModelTurns).toBe(Number.MAX_SAFE_INTEGER);
    expect(l.toolTimeoutMs).toBe(180_000); // 60s * 3
  });

  it("slow models get longer timeouts; unknown speed means factor 1", () => {
    const slow = resolveLimits({ role: role(), agent: agent(), profile: normal, ceiling: 60, model: modelFor(perf({ tokPerSec: 10 })) });
    expect(slow.toolTimeoutMs).toBe(240_000); // 60s * 4 (clamped)
    expect(slow.modelCallTimeoutMs).toBe(4 * DEFAULT_MODEL_CALL_TIMEOUT_MS);
    const fast = resolveLimits({ role: role(), agent: agent(), profile: normal, ceiling: 60, model: modelFor(perf({ tokPerSec: 80 })) });
    expect(fast.toolTimeoutMs).toBe(30_000);
    const unknown = resolveLimits({ role: role(), agent: agent(), profile: normal, ceiling: 60 });
    expect(unknown.toolTimeoutMs).toBe(60_000);
  });

  it("costly agents get fewer turns; unreliable tool users get fewer", () => {
    const pricey = resolveLimits({
      role: role(),
      agent: agent({ billing: "priced", price: { inPerMTok: 40, outPerMTok: 40 } }),
      profile: normal,
      ceiling: 60,
      model: modelFor(),
    });
    expect(pricey.maxModelTurns).toBe(13); // 25 * 0.5 (costFactor clamped)
    const flaky = resolveLimits({ role: role(), agent: agent(), profile: normal, ceiling: 60, model: modelFor(perf({ toolReliability: 0.3 })) });
    expect(flaky.maxModelTurns).toBe(19); // 25 * 0.75
    const free = resolveLimits({
      role: role(),
      agent: agent({ billing: "priced", price: { inPerMTok: 0.1, outPerMTok: 0.1 } }),
      profile: normal,
      ceiling: 60,
    });
    expect(free.maxModelTurns).toBe(38); // 25 * 1.5 (cheap boost clamped)
  });

  it("agent.budget overrides derived factors", () => {
    const l = resolveLimits({
      role: role(),
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

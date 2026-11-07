import type { AgentDef, RoleDef } from "./config/schema.js";
import { roleTurnBudget } from "./roles.js";
import { blendedCost } from "./catalog.js";
import { isCosting } from "./orchestration/ledger.js";
import type { ModelProfile } from "./modelProfile.js";
import { DEFAULT_LIMITS, type LoopLimits } from "./tools/toolLoop.js";

export type BudgetProfileName = "quick" | "normal" | "deep";

export interface BudgetProfile {
  turnMultiplier: number;
  timeoutMultiplier: number;
  allowSplit: boolean;
  /** 0 = no profile-level time cap; settings.maxRunHours remains the ceiling. */
  maxRunMinutes: number;
}

export const BUDGET_PROFILE_NAMES: BudgetProfileName[] = ["quick", "normal", "deep"];

/** Defaults mirror the settings schema; used when a profile is absent. */
export const DEFAULT_BUDGET_PROFILES: Record<BudgetProfileName, BudgetProfile> = {
  quick: { turnMultiplier: 0.4, timeoutMultiplier: 0.5, allowSplit: false, maxRunMinutes: 10 },
  normal: { turnMultiplier: 1.0, timeoutMultiplier: 1.0, allowSplit: true, maxRunMinutes: 60 },
  deep: { turnMultiplier: 2.0, timeoutMultiplier: 3.0, allowSplit: true, maxRunMinutes: 0 },
};

export const REF_TOK_PER_SEC = 40;
export const REF_BLENDED_COST = 3;
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 300_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function budgetProfile(settings: { budgets?: Partial<Record<BudgetProfileName, BudgetProfile>> }, name: BudgetProfileName | undefined): BudgetProfile {
  return settings.budgets?.[name ?? "normal"] ?? DEFAULT_BUDGET_PROFILES[name ?? "normal"];
}

/** Smaller non-zero of the global hour ceiling and the profile minute cap, in ms (0 = none). */
export function effectiveRunCapMs(maxRunHours: number, profile: BudgetProfile): number {
  const h = maxRunHours > 0 ? maxRunHours * 3_600_000 : 0;
  const m = profile.maxRunMinutes > 0 ? profile.maxRunMinutes * 60_000 : 0;
  if (h === 0) return m;
  if (m === 0) return h;
  return Math.min(h, m);
}

/** Compaction thresholds by profile: shorter-turn (quick) profiles compact earlier, longer (deep) later. */
export function compactionThresholds(profile: BudgetProfile): { pruneAt: number; summarizeAt: number } {
  if (profile.turnMultiplier < 1) return { pruneAt: 0.4, summarizeAt: 0.6 };
  if (profile.turnMultiplier > 1) return { pruneAt: 0.75, summarizeAt: 0.9 };
  return { pruneAt: 0.6, summarizeAt: 0.8 };
}

/**
 * Model-aware limits: turn budget scaled by profile and by cost/reliability
 * factors, tool and per-model-call timeouts scaled by profile and measured
 * speed. `agent.budget` overrides the derived factors; unknown measurements
 * mean factor 1, never 0. `turnBudget: "unlimited"` stays unlimited.
 */
export function resolveLimits(opts: {
  role?: RoleDef;
  agent?: AgentDef;
  profile: BudgetProfile;
  /** settings.maxWorkerTurnsCeiling. */
  ceiling: number;
  /** Resolved model facts (perf, price); see `profileFromChannel`. */
  model?: ModelProfile;
}): LoopLimits {
  const { role, agent, profile } = opts;
  const perf = opts.model?.perf;
  const timeoutFactor =
    agent?.budget?.timeoutFactor ?? clamp(REF_TOK_PER_SEC / (perf?.tokPerSec ?? REF_TOK_PER_SEC), 0.5, 4);
  const reliabilityFactor = perf?.toolReliability !== undefined && perf.toolReliability < 0.67 ? 0.75 : 1;
  let costFactor = 1;
  if (agent && isCosting(agent)) {
    const blended = blendedCost(agent.price) ?? blendedCost(opts.model?.price);
    if (blended !== undefined && blended > 0) costFactor = clamp(REF_BLENDED_COST / blended, 0.5, 1.5);
  }
  const turnFactor = agent?.budget?.turnFactor ?? costFactor * reliabilityFactor;
  const baseTurns = role ? roleTurnBudget(role) : DEFAULT_LIMITS.maxModelTurns;
  const maxModelTurns =
    baseTurns === Number.MAX_SAFE_INTEGER
      ? baseTurns
      : Math.min(Math.max(Math.round(baseTurns * profile.turnMultiplier * turnFactor), Math.min(3, baseTurns)), Math.ceil(opts.ceiling * profile.turnMultiplier));
  return {
    ...DEFAULT_LIMITS,
    maxModelTurns,
    ...compactionThresholds(profile),
    toolTimeoutMs: Math.round(DEFAULT_LIMITS.toolTimeoutMs * profile.timeoutMultiplier * timeoutFactor),
    modelCallTimeoutMs: Math.round(DEFAULT_MODEL_CALL_TIMEOUT_MS * profile.timeoutMultiplier * timeoutFactor),
  };
}

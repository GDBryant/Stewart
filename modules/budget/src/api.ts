// Public surface of @stewart/budget. Only this file is importable from outside.
export {
  BUDGET_PROFILE_NAMES, DEFAULT_BUDGET_PROFILES, DEFAULT_LIMITS, DEFAULT_MODEL_CALL_TIMEOUT_MS,
  budgetProfile, effectiveRunCapMs, compactionThresholds, contextCharsFor, toolOutputCap, resolveLimits,
} from "./limits.js";
export type { BudgetProfile, BudgetProfileName, LoopLimits, AgentBudgetInput } from "./limits.js";
export { classifyTask } from "./taskSize.js";
export type { TaskSize, TaskSizeCtx } from "./taskSize.js";

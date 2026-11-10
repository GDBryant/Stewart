// Public surface of @stewart/orchestration. Only this file is importable from outside.
export { runOrchestrated } from "./orchestratedRun.js";
export { resolveRole, isOrchestrationRole, ORCHESTRATOR_DEFAULT_TOOLS } from "./orchestrator.js";
export type { OrchestrationOutcome } from "./orchestrator.js";
export { runRoleTask, buildRolePrompt, compactionFor, compactorFor } from "./roleRunner.js";
export { orchestrationTools } from "./tools.js";
export type { OrchestrationHandlers } from "./tools.js";
export { freeCandidates, rankDeterministic, validateReplacements, parseReplacements } from "./replacements.js";
export type { ParkedRole, Replacement } from "./replacements.js";

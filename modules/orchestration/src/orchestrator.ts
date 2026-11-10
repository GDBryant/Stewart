import type { RoleDef } from "@stewart/config";
import type { OrchestrationRuntime } from "@stewart/agent-loop";
import type { Replacement } from "./replacements.js";

export interface OrchestrationOutcome {
  status: "done" | "failed" | "cancelled" | "stopped" | "no_dispatch";
  error?: string;
  reply?: string;
  suggestions: Replacement[];
}

const ORCHESTRATION_ROLES = new Set(["orchestrator"]);
/** Used when the orchestrator role lists no tools: routing only, never project tools. */
export const ORCHESTRATOR_DEFAULT_TOOLS = ["dispatch", "ask_user", "submit_plan", "submit_verdict", "submit_replacements", "health_report"];
export const ORCHESTRATOR_MAX_TOOL_OUTPUT = 4_000;

/** Resolve an enabled role by id. Unknown or disabled ids return undefined; there is no silent fallback. */
export function resolveRole(rt: OrchestrationRuntime, roleId: string): RoleDef | undefined {
  return rt.config.roles.find((r) => r.id === roleId && r.enabled);
}

export function isOrchestrationRole(roleId: string): boolean {
  return ORCHESTRATION_ROLES.has(roleId);
}

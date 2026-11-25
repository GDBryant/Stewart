import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { agentContext, agentRefusal } from "./chain.js";

/** A window this small compacts constantly on a long run (E7 of the harness-efficiency plan). */
export const SMALL_WINDOW = 32_768;
/** A turn budget above this counts as a long run. */
export const LONG_BUDGET = 40;

/** The role's effective turn budget: the lead's is `settings.runTurnLimit`; "unlimited" counts as very long. */
function budgetOf(role: RoleDef, leadBudget: number): number {
  if (role.id === "lead") return leadBudget;
  return role.turnBudget === "unlimited" ? Number.POSITIVE_INFINITY : role.turnBudget;
}

/**
 * Settings warnings (prefixed `warning:`) for enabled agent-kind roles whose bound agent has a known window ≤ 32k
 * while the role's turn budget is > 40: such runs compact every few requests. Unknown windows are not warned.
 */
export function roleWindowWarnings(roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[], leadBudget: number): string[] {
  return roles.flatMap((r) => roleWarning(r, agents, channels, leadBudget));
}

function roleWarning(r: RoleDef, agents: AgentDef[], channels: ChannelDef[], leadBudget: number): string[] {
  if (!r.enabled || (r.kind ?? "agent") !== "agent" || !r.agent) return [];
  const agent = agents.find((a) => a.id === r.agent);
  const window = agent ? agentContext(agent, channels) : undefined;
  const budget = budgetOf(r, leadBudget);
  if (window === undefined || window > SMALL_WINDOW || budget <= LONG_BUDGET) return [];
  const shown = Number.isFinite(budget) ? String(budget) : "unlimited";
  return [`warning: role ${r.id}: agent '${r.agent}' has a ${window}-token window but the turn budget is ${shown}; long runs will compact often. Use a larger-window agent (heavyAgent), lower the budget, or re-run Qualify if the model's window is larger.`];
}

/** Errors for an enabled role's `heavyAgent`: it must exist and be one the role accepts. */
export function heavyAgentErrors(roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): string[] {
  const out: string[] = [];
  for (const r of roles) {
    if (!r.enabled || !r.heavyAgent) continue;
    const agent = agents.find((a) => a.id === r.heavyAgent);
    if (!agent) {
      out.push(`role ${r.id}: unknown heavyAgent '${r.heavyAgent}'`);
      continue;
    }
    const why = agentRefusal(r, agent, channels);
    if (why) out.push(`role ${r.id}: heavyAgent '${r.heavyAgent}' not usable: ${why}`);
  }
  return out;
}

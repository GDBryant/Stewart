import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { resolveModelProfile } from "@stewart/models";

export const DEFAULT_MIN_CONTEXT = 32_000;

/** What a role needs from its model. The 32k default window applies to agents only: functions need none unless set. */
export function roleNeeds(role: RoleDef): { vision: boolean; minContext: number } {
  const fallback = (role.kind ?? "agent") === "agent" ? DEFAULT_MIN_CONTEXT : 0;
  return { vision: role.needs?.vision ?? false, minContext: role.needs?.minContext ?? fallback };
}

/** Effective chain: explicit `chain`, else `[agent]`, else the lead's chain (for lead: the first agent). */
export function roleChainIds(role: RoleDef, roles: RoleDef[], agents: AgentDef[]): string[] {
  if (role.chain?.length) return role.chain;
  if (role.agent) return [role.agent];
  if (role.id !== "lead") {
    const lead = roles.find((r) => r.id === "lead" && r.id !== role.id);
    if (lead) return roleChainIds(lead, roles, agents);
  }
  return agents.length ? [agents[0].id] : [];
}

function capsOf(agent: AgentDef, channels: ChannelDef[]) {
  return resolveModelProfile({ channels }, { channel: agent.channel, model: agent.model });
}

/** The agent's usable context window in tokens, or undefined when unknown. */
export function agentContext(agent: AgentDef, channels: ChannelDef[]): number | undefined {
  return capsOf(agent, channels).contextTokens;
}

/**
 * Why an agent may not serve a role, or null when it may: it needs a passing qualification record for the role
 * kind, a context window of at least `minContext` (an unknown window is admitted: many providers do not report
 * one, and qualification already ran a multi-turn task), and vision when the role needs it.
 */
export function agentRefusal(role: RoleDef, agent: AgentDef, channels: ChannelDef[]): string | null {
  const kind = role.kind ?? "agent";
  const needs = roleNeeds(role);
  const p = capsOf(agent, channels);
  const q = p.caps.qualified?.[kind];
  if (q?.passed !== true) return q?.passed === false ? `failed ${kind} qualification` : `not qualified as ${kind} (run Qualify)`;
  if (p.contextTokens !== undefined && p.contextTokens < needs.minContext) return `context window ${p.contextTokens} < ${needs.minContext}`;
  if (needs.vision && p.caps.vision !== true) return "role needs vision";
  return null;
}

/** Eligible agents for a role in chain order (see `agentRefusal`); refused agents are never run. */
export function eligibleChain(role: RoleDef, roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): AgentDef[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return roleChainIds(role, roles, agents)
    .map((id) => byId.get(id))
    .filter((a): a is AgentDef => a !== undefined)
    .filter((a) => agentRefusal(role, a, channels) === null);
}

/**
 * Config errors for an enabled role's saved chain (or bound agent): unknown ids, and agents the role refuses
 * (`agentRefusal`). Shown in Settings so a bad assignment is visible before a run.
 */
export function chainErrors(role: RoleDef, agents: AgentDef[], channels: ChannelDef[]): string[] {
  const ids = role.chain?.length ? role.chain : role.agent ? [role.agent] : [];
  if (!role.enabled || !ids.length) return [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return ids.map((id) => chainEntryError(role, id, byId.get(id), channels)).filter((e): e is string => e !== null);
}

/** One chain entry's error; an unknown bound `agent` is reported by validateRoles instead. */
function chainEntryError(role: RoleDef, id: string, agent: AgentDef | undefined, channels: ChannelDef[]): string | null {
  if (!agent) return role.chain?.length ? `role ${role.id}: unknown chain agent '${id}'` : null;
  const why = agentRefusal(role, agent, channels);
  return why ? `role ${role.id}: agent '${id}' ${why}` : null;
}

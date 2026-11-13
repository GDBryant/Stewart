import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { resolveModelProfile, QUAL_MIN_VERSION } from "@stewart/models";

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
 * Why an agent may not serve a role, or null when it may: it needs a current passing qualification record for
 * the role kind, a context window of at least `minContext` (the verified window in the record stands in when
 * the provider reports none; an unknown window is refused), and vision when the role needs it.
 */
export function agentRefusal(role: RoleDef, agent: AgentDef, channels: ChannelDef[]): string | null {
  const kind = role.kind ?? "agent";
  const needs = roleNeeds(role);
  const p = capsOf(agent, channels);
  const q = p.caps.qualified?.[kind];
  if (q?.passed !== true) return q?.passed === false ? `failed ${kind} qualification` : `not qualified as ${kind} (run Qualify)`;
  if (q.version < QUAL_MIN_VERSION) return "qualification out of date (run Qualify)";
  return contextRefusal(needs.minContext, p.contextTokens ?? q.context) ?? (needs.vision && p.caps.vision !== true ? "role needs vision" : null);
}

function contextRefusal(minContext: number, window: number | undefined): string | null {
  if (minContext <= 0) return null;
  if (window === undefined) return "context window unknown (run Qualify)";
  return window < minContext ? `context window ${window} < ${minContext}` : null;
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

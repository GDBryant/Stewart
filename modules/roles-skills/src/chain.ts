import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { resolveModelProfile } from "@stewart/models";

export const DEFAULT_MIN_CONTEXT = 32_000;

export function roleNeeds(role: RoleDef): { vision: boolean; minContext: number } {
  return { vision: role.needs?.vision ?? false, minContext: role.needs?.minContext ?? DEFAULT_MIN_CONTEXT };
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
 * Eligible agents for a role in chain order: only agents with a passing
 * qualification record for the role kind and a context window (when known) of at least
 * the role's `minContext`. Unqualified, failed and too-small agents are never run.
 */
export function eligibleChain(role: RoleDef, roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): AgentDef[] {
  const kind = role.kind ?? "agent";
  const { minContext } = roleNeeds(role);
  const byId = new Map(agents.map((a) => [a.id, a]));
  return roleChainIds(role, roles, agents)
    .map((id) => byId.get(id))
    .filter((a): a is AgentDef => a !== undefined)
    .filter((a) => {
      const p = capsOf(a, channels);
      return p.caps.qualified?.[kind]?.passed === true && (p.contextTokens === undefined || p.contextTokens >= minContext);
    });
}

/** Config error when a saved chain entry is unknown or failed qualification for the role kind. */
export function chainErrors(role: RoleDef, agents: AgentDef[], channels: ChannelDef[]): string[] {
  if (!role.chain?.length) return [];
  const kind = role.kind ?? "agent";
  const byId = new Map(agents.map((a) => [a.id, a]));
  const errors: string[] = [];
  for (const id of role.chain) {
    const agent = byId.get(id);
    if (!agent) errors.push(`role ${role.id}: unknown chain agent '${id}'`);
    else if (capsOf(agent, channels).caps.qualified?.[kind]?.passed === false) errors.push(`role ${role.id}: chain agent '${id}' failed ${kind} qualification`);
  }
  return errors;
}

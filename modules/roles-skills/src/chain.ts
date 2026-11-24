import type { AgentDef, ChannelDef, Effort, RoleDef } from "@stewart/config";
import { resolveModelProfile, QUAL_MIN_VERSION } from "@stewart/models";

export const DEFAULT_MIN_CONTEXT = 32_000;

/** Effective reasoning depth: the role override wins, then the agent's value, then medium. */
export function effectiveEffort(role: RoleDef, agent: AgentDef): Effort {
  return role.effort ?? agent.effort ?? "medium";
}

/** What a role needs from its model. The 32k default window applies to agents only: functions need none unless set. */
export function roleNeeds(role: RoleDef): { vision: boolean; minContext: number } {
  const fallback = (role.kind ?? "agent") === "agent" ? DEFAULT_MIN_CONTEXT : 0;
  return { vision: role.needs?.vision ?? false, minContext: role.needs?.minContext ?? fallback };
}

/** Effective chain: `[agent, secondary]` deduped, else the lead's chain (for lead: the first agent). */
export function roleChainIds(role: RoleDef, roles: RoleDef[], agents: AgentDef[]): string[] {
  if (role.agent) return [...new Set([role.agent, role.secondary].filter((x): x is string => Boolean(x)))];
  if (role.id !== "lead") {
    const lead = roles.find((r) => r.id === "lead" && r.id !== role.id);
    if (lead) return roleChainIds(lead, roles, agents);
  }
  return agents.length ? [agents[0].id] : [];
}

function capsOf(agent: AgentDef, channels: ChannelDef[]) {
  return resolveModelProfile({ channels }, { channel: agent.channel, model: agent.model });
}

/** The agent's usable context window in tokens, or undefined when unknown; the agent qualification probe's measured window is the fallback. */
export function agentContext(agent: AgentDef, channels: ChannelDef[]): number | undefined {
  const p = capsOf(agent, channels);
  return p.contextTokens ?? p.caps.qualified?.agent?.context;
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

/** Effort ordering for the divert tie-break: a deeper depth ranks higher. */
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, max: 3 };

/**
 * Capability-aware divert target after a loop-guard trip: the strongest reasoning-capable agent that may
 * serve the role. Eligibility is `agentRefusal === null` + the agent's channel enabled + not the tripping
 * agent and not already tried (cross-role agents are eligible). Ranking (stable): `explicit` first if
 * eligible, then reasoning-capable over unknown, then wider context window, then deeper effective effort.
 * Caps come from `resolveModelProfile` (probe results are merged into `channels[].modelCaps` before run),
 * so no raw caps read happens here. Returns undefined when nothing is eligible → the caller keeps the
 * static chain (no regression).
 */
export function divertTarget(opts: {
  candidates: AgentDef[]; // all agents; the tripping one is excluded via `current`/`tried`
  current: AgentDef; // the agent that just tripped the loop guard
  channels: ChannelDef[]; // for agentRefusal + channel-enabled checks
  role: RoleDef; // for agentRefusal + the effort tie-break
  explicit?: string; // settings escalation.onLoopGuard.agent (wins when eligible)
  tried?: string[]; // agent ids already attempted this run
}): AgentDef | undefined {
  const { candidates, current, channels, role, explicit, tried = [] } = opts;
  const triedSet = new Set(tried);
  const eligible = candidates.filter((a) => {
    if (a.id === current.id || triedSet.has(a.id)) return false;
    const ch = channels.find((c) => c.id === a.channel);
    return ch?.enabled !== false && agentRefusal(role, a, channels) === null;
  });
  const explicitHit = explicit ? eligible.find((a) => a.id === explicit) : undefined;
  if (explicitHit) return explicitHit;
  const ranked = eligible
    .map((a) => ({ a, p: capsOf(a, channels) }))
    .sort(
      (x, y) =>
        Number(y.p.caps.reasoning === true) - Number(x.p.caps.reasoning === true) ||
        (y.p.contextTokens ?? 0) - (x.p.contextTokens ?? 0) ||
        EFFORT_RANK[effectiveEffort(role, y.a)] - EFFORT_RANK[effectiveEffort(role, x.a)],
    );
  return ranked[0]?.a;
}

/**
 * Config errors for an enabled role's bound agent + secondary: unknown ids, and agents the role refuses
 * (`agentRefusal`). Shown in Settings so a bad assignment is visible before a run.
 */
export function chainErrors(role: RoleDef, agents: AgentDef[], channels: ChannelDef[]): string[] {
  const ids = role.agent ? [...new Set([role.agent, role.secondary].filter((x): x is string => Boolean(x)))] : [];
  if (!role.enabled || !ids.length) return [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return ids.map((id) => chainEntryError(role, id, byId.get(id), channels)).filter((e): e is string => e !== null);
}

/** One chain entry's error; an unknown bound `agent` is reported by validateRoles instead. */
function chainEntryError(role: RoleDef, id: string, agent: AgentDef | undefined, channels: ChannelDef[]): string | null {
  if (!agent) return id === role.secondary ? `role ${role.id}: unknown secondary agent '${id}'` : null;
  const why = agentRefusal(role, agent, channels);
  return why ? `role ${role.id}: agent '${id}' ${why}` : null;
}

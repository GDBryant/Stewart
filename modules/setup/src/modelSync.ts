import type { AgentDef, RoleDef } from "@stewart/config";

/** A channel that answered listModels; `models` already includes its `extraModels`. */
export interface ListedChannel {
  id: string;
  type: string;
  models: string[];
}

export interface AddedModel {
  channel: string;
  model: string;
  channelType: string;
}

export interface GoneAgent {
  agent: AgentDef;
  /** Role ids binding this agent via `agent` or `secondary`. */
  roles: string[];
}

export interface ModelDiff {
  added: AddedModel[];
  gone: GoneAgent[];
}

/**
 * Diff listed channel models against config agents: models with no agent →
 * `added`; agents on a reachable channel whose model is unlisted → `gone`.
 * Unreachable channels are simply absent from `listed` — their agents are never gone.
 */
export function diffModels(agents: AgentDef[], roles: RoleDef[], listed: ListedChannel[]): ModelDiff {
  const pairs = new Set(agents.map((a) => `${a.channel}:${a.model}`));
  const added: AddedModel[] = [];
  for (const ch of listed) {
    for (const model of ch.models) {
      if (!pairs.has(`${ch.id}:${model}`)) added.push({ channel: ch.id, model, channelType: ch.type });
    }
  }
  const gone: GoneAgent[] = [];
  for (const ch of listed) {
    const models = new Set(ch.models);
    for (const agent of agents) {
      if (agent.channel === ch.id && !models.has(agent.model)) {
        gone.push({ agent, roles: boundRoles(roles, agent.id) });
      }
    }
  }
  return { added, gone };
}

function boundRoles(roles: RoleDef[], agentId: string): string[] {
  return roles.filter((r) => r.agent === agentId || r.secondary === agentId).map((r) => r.id);
}

export type AgentBilling = NonNullable<AgentDef["billing"]>;

/** Same billing policy as the wizard (`wizardApply.billingFor`): priced > free-zero > channel default. */
export function billingFor(channelType: string | undefined, inPerMTok: number | undefined): AgentBilling {
  if (inPerMTok !== undefined && inPerMTok > 0) return "priced";
  if (inPerMTok === 0) return "free";
  if (channelType === "ollama") return "free";
  if (channelType === "claude-cli") return "reported";
  return "unmetered";
}

/** `<channel>-<model>` with model's non-id characters folded to `-` (same id policy as the wizard). */
export function agentIdBase(channel: string, model: string): string {
  return `${channel}-${model.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function uniqueAgentId(base: string, taken: (id: string) => boolean): string {
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/** New AgentDef for a channel:model pair: deduped `ch-model` id, medium effort, billing/price from channel type + catalog. */
export function mintAgent(o: {
  channel: string;
  model: string;
  channelType?: string;
  price?: { inPerMTok?: number; outPerMTok?: number };
  taken: (id: string) => boolean;
}): AgentDef {
  const pin = o.price?.inPerMTok;
  const priced = pin !== undefined && pin > 0;
  return {
    id: uniqueAgentId(agentIdBase(o.channel, o.model), o.taken),
    channel: o.channel,
    model: o.model,
    effort: "medium",
    billing: billingFor(o.channelType, pin),
    ...(priced ? { price: { inPerMTok: pin, outPerMTok: o.price?.outPerMTok ?? pin } } : {}),
    ...(o.channelType === "claude-cli" ? { costs: true } : {}),
  };
}

export type RawItems = Record<string, unknown>[];

/** Raw user-file item lists (unknown fields preserved); `roles` may be `[]` when no user roles.yaml exists. */
export interface SyncDocs {
  agents: RawItems;
  roles: RawItems;
  channels: RawItems;
}

export interface SyncDecisions {
  addAgents?: RawItems;
  removeAgents?: ReadonlySet<string>;
  disableChannels?: ReadonlySet<string>;
  removeChannels?: ReadonlySet<string>;
}

export interface SyncApplyResult extends SyncDocs {
  changed: boolean;
}

/** Applies refresh decisions to raw items: agent remove/append, role unbind of removed ids, channel disable/remove. */
export function applyDecisions(docs: SyncDocs, d: SyncDecisions): SyncApplyResult {
  const removeAgents = d.removeAgents ?? new Set<string>();
  const agents = [...docs.agents.filter((i) => !removeAgents.has(String(i.id))), ...(d.addAgents ?? [])];
  const roles = docs.roles.map((r) => unbindRole(r, removeAgents));
  const channels = docs.channels
    .filter((i) => !(d.removeChannels ?? new Set()).has(String(i.id)))
    .map((i) => ((d.disableChannels ?? new Set()).has(String(i.id)) ? { ...i, enabled: false } : i));
  const changed =
    agents.length !== docs.agents.length ||
    roles.some((r, i) => r !== docs.roles[i]) ||
    channels.length !== docs.channels.length ||
    channels.some((c, i) => c !== docs.channels[i]);
  return { agents, roles, channels, changed };
}

/** String ids of a legacy role `chain` (pre-`agent`/`secondary`; migrated at load). */
function legacyChain(chain: unknown): string[] {
  return Array.isArray(chain) ? chain.filter((x): x is string => typeof x === "string") : [];
}

/** The agent a role item resolves to at load: `agent`, else the head of a legacy `chain`. */
export function effectiveAgent(role: Record<string, unknown>): string | undefined {
  return typeof role.agent === "string" && role.agent ? role.agent : legacyChain(role.chain)[0];
}

/** The secondary a legacy `chain` contributes (mirrors `migrateRoleChain`): first tail entry, only when the head is the agent. */
function chainSecondary(agent: string | undefined, chain: string[]): string | undefined {
  return agent !== undefined && chain.length && chain[0] === agent ? chain.find((id) => id !== agent) : undefined;
}

/**
 * Reset rule for removed agents: a removed `secondary` (field or live `chain` tail) is dropped; a
 * removed effective `agent` promotes the surviving secondary, else the role is unbound (inherits
 * the lead's chain). The legacy `chain` is kept consistent with `migrateRoleChain`: a dropped
 * secondary or agent removes the whole chain (a tail would migrate back in), a stale chain (head
 * is not the effective agent) is dropped rather than filtered, a dead tail entry is filtered out.
 * Untouched roles are returned by identity.
 */
function unbindRole(role: Record<string, unknown>, removed: ReadonlySet<string>): Record<string, unknown> {
  const chain = legacyChain(role.chain);
  const agent = effectiveAgent(role);
  const secondary = (typeof role.secondary === "string" && role.secondary) || chainSecondary(agent, chain) || undefined;
  if (agent !== undefined && removed.has(agent)) return unboundPrimary(role, secondary, removed);
  if (secondary !== undefined && removed.has(secondary)) return unboundSecondary(role, agent, chain);
  if (chain.some((id) => removed.has(id))) {
    if (chain[0] !== agent) {
      const next = { ...role };
      delete next.chain;
      return next;
    }
    return filterChain(role, chain, removed);
  }
  return role;
}

/** The agent is gone: unbind, or promote a surviving secondary (field or chain tail). */
function unboundPrimary(role: Record<string, unknown>, secondary: string | undefined, removed: ReadonlySet<string>): Record<string, unknown> {
  const next = { ...role };
  delete next.agent;
  delete next.secondary;
  delete next.chain;
  if (secondary !== undefined && !removed.has(secondary)) next.agent = secondary;
  return next;
}

/** The secondary is gone: drop it, and the whole chain (a tail would migrate back in as secondary). */
function unboundSecondary(role: Record<string, unknown>, agent: string | undefined, chain: string[]): Record<string, unknown> {
  const next = { ...role };
  delete next.secondary;
  if (agent !== undefined && chain[0] === agent) next.agent = agent; // keep a chain-sourced agent when the chain goes
  delete next.chain;
  return next;
}

/** A dead, non-binding chain tail: filter it (binding stays intact). */
function filterChain(role: Record<string, unknown>, chain: string[], removed: ReadonlySet<string>): Record<string, unknown> {
  const kept = chain.filter((id) => !removed.has(id));
  const next = { ...role };
  if (kept.length) next.chain = kept;
  else delete next.chain;
  return next;
}

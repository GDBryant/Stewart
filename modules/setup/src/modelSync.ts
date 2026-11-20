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

function unbindRole(role: Record<string, unknown>, removed: ReadonlySet<string>): Record<string, unknown> {
  const dropAgent = typeof role.agent === "string" && removed.has(role.agent);
  const dropSecondary = typeof role.secondary === "string" && removed.has(role.secondary);
  if (!dropAgent && !dropSecondary) return role;
  const next = { ...role };
  if (dropAgent) delete next.agent;
  if (dropSecondary) delete next.secondary;
  return next;
}

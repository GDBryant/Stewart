import type { AgentSummary, CatalogInfo, ChannelSummary, RoleSummary } from "./bridge.js";
import type { State } from "./state.js";

function billingFor(channelType: string | undefined, inPerMTok: number | undefined): string {
  if (inPerMTok !== undefined && inPerMTok > 0) return "priced";
  if (inPerMTok === 0) return "free";
  if (channelType === "ollama") return "free";
  if (channelType === "claude-cli") return "reported";
  return "unmetered";
}

function uniqueAgentId(base: string, taken: (id: string) => boolean): string {
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

type PairAgentInput = {
  id: string;
  channel: string;
  model: string;
  channelType: string | undefined;
  catalog: CatalogInfo | undefined;
};

function agentForPair({ id, channel, model, channelType, catalog }: PairAgentInput): AgentSummary {
  const pin = catalog?.inPerMTok;
  const priced = pin !== undefined && pin > 0;
  return {
    id,
    channel,
    model,
    effort: "medium",
    billing: billingFor(channelType, pin),
    ...(priced ? { price: { inPerMTok: pin, outPerMTok: catalog?.outPerMTok ?? pin } } : {}),
    ...(channelType === "claude-cli" ? { costs: true } : {}),
  };
}

type AgentPool = {
  agents: AgentSummary[];
  channels: ChannelSummary[];
  probeResults: State["probeResults"];
  nextAgents: Map<string, AgentSummary>;
};

/** Existing agent id for the pair, else the id of a newly created agent. */
function ensureAgent(pool: AgentPool, channel: string, model: string): string {
  const existing = pool.agents.find((a) => a.channel === channel && a.model === model);
  if (existing) return existing.id;
  const base = `${channel}-${model.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const id = uniqueAgentId(base, (x) => pool.nextAgents.has(x));
  const channelType = pool.channels.find((c) => c.id === channel)?.type;
  pool.nextAgents.set(id, agentForPair({ id, channel, model, channelType, catalog: pool.probeResults[`${channel}:${model}`]?.catalog }));
  return id;
}

export function buildAgentsForRoles(input: {
  agents: AgentSummary[];
  channels: ChannelSummary[];
  roles: RoleSummary[];
  chosen: { role: string; ref: string }[];
  probeResults: State["probeResults"];
  secondaries?: { role: string; ref: string }[];
  /** Probe pairs that passed qualification: each gets an agent even without a role binding. */
  passed?: { channel: string; model: string }[];
  /** Ids already in the live roster. Unchosen pre-existing rows are written disabled; unchosen template candidates are omitted entirely. */
  rosterIds?: Set<string>;
}): { agents: AgentSummary[]; roles: RoleSummary[] } {
  const { agents, channels, roles, chosen, probeResults, secondaries } = input;
  const pairToAgent = new Map<string, string>();
  const nextAgents = new Map(agents.map((a) => [a.id, { ...a }] as const));
  const pool = { agents, channels, probeResults, nextAgents };
  const allRefs = [...chosen.map((c) => c.ref), ...(secondaries ?? []).map((c) => c.ref), ...(input.passed ?? []).map((p) => `${p.channel}:${p.model}`)];
  for (const ref of allRefs) {
    if (!ref || pairToAgent.has(ref)) continue;
    const i = ref.indexOf(":");
    pairToAgent.set(ref, ensureAgent(pool, ref.slice(0, i), ref.slice(i + 1)));
  }
  const nextRoles = roles.flatMap((r) => {
    const ref = chosen.find((c) => c.role === r.id)?.ref;
    if (!ref) {
      if (input.rosterIds && !input.rosterIds.has(r.id)) return [];
      return [{ ...r, enabled: false }];
    }
    const agent = pairToAgent.get(ref);
    const secRef = secondaries?.find((c) => c.role === r.id)?.ref;
    const sec = secRef ? pairToAgent.get(secRef) : undefined;
    return [{ ...r, agent, secondary: sec && sec !== agent ? sec : undefined, enabled: true }];
  });
  return { agents: [...nextAgents.values()], roles: nextRoles };
}

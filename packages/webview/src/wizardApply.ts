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

export function buildAgentsForRoles(input: {
  agents: AgentSummary[];
  channels: ChannelSummary[];
  roles: RoleSummary[];
  chosen: { role: string; ref: string }[];
  probeResults: State["probeResults"];
}): { agents: AgentSummary[]; roles: RoleSummary[] } {
  const { agents, channels, roles, chosen, probeResults } = input;
  const pairToAgent = new Map<string, string>();
  const nextAgents = new Map(agents.map((a) => [a.id, { ...a }] as const));
  for (const { ref } of chosen) {
    if (!ref || pairToAgent.has(ref)) continue;
    const i = ref.indexOf(":");
    const ch = ref.slice(0, i);
    const model = ref.slice(i + 1);
    const existing = agents.find((a) => a.channel === ch && a.model === model);
    if (existing) {
      pairToAgent.set(ref, existing.id);
      continue;
    }
    const base = `${ch}-${model.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const id = uniqueAgentId(base, (x) => nextAgents.has(x));
    const channelType = channels.find((c) => c.id === ch)?.type;
    nextAgents.set(id, agentForPair({ id, channel: ch, model, channelType, catalog: probeResults[ref]?.catalog }));
    pairToAgent.set(ref, id);
  }
  const nextRoles = roles.map((r) => {
    const ref = chosen.find((c) => c.role === r.id)?.ref;
    return ref ? { ...r, agent: pairToAgent.get(ref), enabled: true } : { ...r, enabled: false };
  });
  return { agents: [...nextAgents.values()], roles: nextRoles };
}

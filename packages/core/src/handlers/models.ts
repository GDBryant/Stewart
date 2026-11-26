import { counterIds, errorMessage } from "@stewart/kernel";
import { questionPrompt } from "@stewart/interaction";
import type { AgentDef, ChannelDef } from "@stewart/config";
import { applyDecisions, diffModels, mintAgent, type AddedModel, type GoneAgent, type ListedChannel, type SyncDocs } from "@stewart/setup";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { reprobeWindows } from "./modelsReprobe.js";
import { catalogFor, docItems, writeItems } from "./util.js";

/** One enabled channel's refresh discovery result; `error` set = unreachable. */
interface ChannelProbe {
  def: ChannelDef;
  models?: string[];
  error?: string;
}

interface RefreshDecisions {
  add: AgentDef[];
  removeAgents: Set<string>;
  disableChannels: Set<string>;
  removeChannels: Set<string>;
}

type Ask = (question: string, options: string[]) => Promise<string | undefined>;

export async function handleModelsRefresh(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  const ctx = core.ctx(p.projectId);
  if (core.refreshInFlight.has(p.projectId)) return { ok: false, error: "models refresh already running" };
  core.refreshInFlight.add(p.projectId);
  try {
    return await runModelsRefresh(core, ctx, p.projectId);
  } finally {
    core.refreshInFlight.delete(p.projectId);
  }
}

async function runModelsRefresh(core: CoreCtx, ctx: ProjectCtx, projectId: string): Promise<unknown> {
  const probes = await discover(core, ctx);
  const ask = asker(ctx, (core.deps.ids ?? counterIds()).next("sync"));
  const d = await collectDecisions(core, ctx, probes, ask);
  const reprobed = await reprobeWindows(core, ctx, new Set(probes.filter((p) => !p.error).map((p) => p.def.id)), ask);
  if (hasChanges(d)) {
    await applyToConfig(core, ctx, d);
    await core.reload(projectId);
  }
  return {
    ok: true,
    added: d.add.map((a) => a.id),
    removed: [...d.removeAgents],
    disabledChannels: [...d.disableChannels],
    removedChannels: [...d.removeChannels],
    unreachable: unreachableIds(probes),
    reprobed,
  };
}

/** listModels per enabled channel, in parallel; per-channel failures are captured, never thrown. */
async function discover(core: CoreCtx, ctx: ProjectCtx): Promise<ChannelProbe[]> {
  return Promise.all(
    ctx.config.channels.filter((c) => c.enabled).map(async (def) => {
      const mc = core.channelService.get(def.id);
      if (!mc) return { def, error: "not configured" };
      try {
        return { def, models: [...new Set([...(await mc.listModels()), ...(def.extraModels ?? [])])] };
      } catch (e) {
        return { def, error: errorMessage(e) };
      }
    }),
  );
}

function asker(ctx: ProjectCtx, runId: string): Ask {
  return async (question, options) => {
    const o = await ctx.interaction.ask(questionPrompt("refresh", question, options), { runId });
    return o.kind === "answered" ? o.value : undefined;
  };
}

interface PromptCtx {
  ask: Ask;
  d: RefreshDecisions;
}

async function collectDecisions(core: CoreCtx, ctx: ProjectCtx, probes: ChannelProbe[], ask: Ask): Promise<RefreshDecisions> {
  const q: PromptCtx = { ask, d: { add: [], removeAgents: new Set(), disableChannels: new Set(), removeChannels: new Set() } };
  await askUnreachable(core, ctx, probes, q);
  const listed = probes.filter((p) => p.models).map((p): ListedChannel => ({ id: p.def.id, type: p.def.type, models: p.models! }));
  const { added, gone } = diffModels(ctx.config.agents, ctx.config.roles, listed);
  await askAdded(core, ctx, added, q);
  await askGone(gone, ask, q.d);
  return q.d;
}

async function askUnreachable(core: CoreCtx, ctx: ProjectCtx, probes: ChannelProbe[], { ask, d }: PromptCtx): Promise<void> {
  for (const p of probes.filter((x) => x.error)) {
    const bound = ctx.config.agents.filter((a) => a.channel === p.def.id);
    const ans = await ask(`channel '${p.def.id}' is unreachable (${p.error}).`, [
      "Keep",
      "Retry once",
      "Disable channel",
      `Remove channel + ${bound.length} agent${bound.length === 1 ? "" : "s"}`,
    ]);
    if (ans === "Retry once" && (await retryList(core, p))) continue;
    if (ans === "Disable channel") d.disableChannels.add(p.def.id);
    else if (ans?.startsWith("Remove channel")) {
      d.removeChannels.add(p.def.id);
      for (const a of bound) d.removeAgents.add(a.id);
    }
  }
}

async function retryList(core: CoreCtx, p: ChannelProbe): Promise<boolean> {
  const models = await core.channelService
    .get(p.def.id)
    ?.listModels()
    .catch(() => undefined);
  if (!models) return false;
  p.models = [...new Set([...models, ...(p.def.extraModels ?? [])])];
  p.error = undefined;
  return true;
}

async function askAdded(core: CoreCtx, ctx: ProjectCtx, added: AddedModel[], { ask, d }: PromptCtx): Promise<void> {
  if (!added.length) return;
  let mode: "all" | "each" | "none" = "each";
  if (added.length > 1) {
    const ans = await ask(`${added.length} new models found. Register agents for them?`, ["Add all", "Ask each", "Skip all"]);
    if (ans === "Add all") mode = "all";
    else if (ans !== "Ask each") mode = "none";
  }
  const taken = new Set(ctx.config.agents.map((a) => a.id));
  for (const a of added) {
    if (mode === "none") break;
    if (mode === "each" && (await ask(`new model '${a.model}' on '${a.channel}'. Register an agent?`, ["Add", "Skip"])) !== "Add") continue;
    const agent = await mintFor(core, a, taken);
    taken.add(agent.id);
    d.add.push(agent);
  }
}

async function mintFor(core: CoreCtx, a: AddedModel, taken: Set<string>): Promise<AgentDef> {
  const mc = core.channelService.get(a.channel);
  const catalog = mc ? await catalogFor(core, mc, a.model) : undefined;
  return mintAgent({ channel: a.channel, model: a.model, channelType: a.channelType, price: catalog, taken: (id) => taken.has(id) });
}

async function askGone(gone: GoneAgent[], ask: Ask, d: RefreshDecisions): Promise<void> {
  for (const g of gone) {
    const roles = g.roles.length ? ` Bound roles: ${g.roles.join(", ")}.` : "";
    const ans = await ask(`model '${g.agent.model}' is no longer listed on '${g.agent.channel}'. Remove agent '${g.agent.id}'?${roles}`, [
      "Remove agent",
      "Keep agent",
    ]);
    if (ans === "Remove agent") d.removeAgents.add(g.agent.id);
  }
}

function hasChanges(d: RefreshDecisions): boolean {
  return d.add.length > 0 || d.removeAgents.size > 0 || d.disableChannels.size > 0 || d.removeChannels.size > 0;
}

function unreachableIds(probes: ChannelProbe[]): string[] {
  return probes.filter((p) => p.error).map((p) => p.def.id);
}

/** Apply accepted refresh decisions to the user files (only the ones that changed). */
async function applyToConfig(core: CoreCtx, ctx: ProjectCtx, d: RefreshDecisions): Promise<void> {
  const docs: SyncDocs = {
    agents: docItems(ctx, "agents.yaml", ctx.config.agents.map((a) => ({ ...a }))),
    roles: docItems(ctx, "roles.yaml", ctx.config.roles.map((r) => ({ ...r }))),
    channels: docItems(ctx, "channels.yaml", ctx.config.channels.map((c) => ({ ...c }))),
  };
  const res = applyDecisions(docs, {
    addAgents: d.add as unknown as Record<string, unknown>[],
    removeAgents: d.removeAgents,
    disableChannels: d.disableChannels,
    removeChannels: d.removeChannels,
  });
  await writeItems(core, "agents.yaml", res.agents, res.agents.length !== docs.agents.length);
  await writeItems(core, "roles.yaml", res.roles, res.roles.some((r, i) => r !== docs.roles[i]));
  await writeItems(core, "channels.yaml", res.channels, res.channels.length !== docs.channels.length || res.channels.some((c, i) => c !== docs.channels[i]));
}

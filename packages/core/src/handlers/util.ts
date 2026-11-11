import type { ManagedChannel } from "@stewart/channels";
import type { ModelInfo } from "@stewart/catalog";
import { CATALOG_UPDATED, lookupModelInfo } from "@stewart/catalog";
import { mergeProbeCaps } from "@stewart/models";
import type { EffectiveConfig } from "@stewart/roles-skills";
import { scanWorkspace, type WorkspaceInfo } from "@stewart/setup";
import type { CoreCtx, ProjectCtx } from "./types.js";

const WS_SCAN_TTL_MS = 24 * 3_600_000;

/** Workspace scan cache (24h TTL) shared by setup.recommend and the task classifier. */
export async function workspaceInfoFor(core: CoreCtx, ctx: ProjectCtx, projectId: string): Promise<WorkspaceInfo | undefined> {
  const hit = core.wsScan.get(projectId);
  if (hit && core.clock.now() - hit.at < WS_SCAN_TTL_MS) return hit.info;
  try {
    const info = await scanWorkspace(ctx.host);
    core.wsScan.set(projectId, { info, at: core.clock.now() });
    return info;
  } catch {
    return undefined;
  }
}

export function applyProbes(core: CoreCtx, config: EffectiveConfig): EffectiveConfig {
  for (const ch of config.channels) {
    for (const [key, entry] of core.probeCache.entries()) {
      if (!key.startsWith(`${ch.id}:`)) continue;
      const model = key.slice(ch.id.length + 1);
      ch.modelCaps[model] = mergeProbeCaps(ch.modelCaps[model], entry.caps);
    }
  }
  return config;
}

/** Live provider pricing wins over the bundled catalog; either may be absent. */
export async function catalogFor(core: CoreCtx, ch: ManagedChannel, model: string): Promise<(ModelInfo & { source: string }) | undefined> {
  if (!core.priceCache.has(ch.cfg.id)) {
    core.priceCache.set(ch.cfg.id, await ch.priceList().catch(() => undefined));
  }
  const live = core.priceCache.get(ch.cfg.id)?.[model];
  if (live) return { ...live, source: "live" };
  const info = lookupModelInfo(ch.cfg.type, model);
  return info ? { ...info, source: `catalog ${CATALOG_UPDATED}` } : undefined;
}

export function pickChatAgent(config: EffectiveConfig, role?: EffectiveConfig["roles"][number]): EffectiveConfig["agents"][number] {
  if (role) {
    if (!role.agent) throw new Error(`role ${role.id}: enabled but no agent bound`);
    const bound = config.agents.find((a) => a.id === role.agent);
    if (!bound) throw new Error(`role ${role.id}: unknown agent '${role.agent}'`);
    return bound;
  }
  const agent = config.agents[0];
  if (!agent) throw new Error("no agent configured — run setup to add a channel and agent");
  return agent;
}

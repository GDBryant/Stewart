import type { ManagedChannel } from "@stewart/channels";
import type { ModelInfo } from "@stewart/catalog";
import { CATALOG_UPDATED, lookupModelInfo } from "@stewart/catalog";
import { mergeProbeCaps } from "@stewart/models";
import type { EffectiveConfig } from "@stewart/roles-skills";
import { scanWorkspace, type WorkspaceInfo } from "@stewart/setup";
import { errorMessage } from "@stewart/kernel";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

/** Memory-first secret apply: live channels + redaction get it even when the host store is down; persist failure surfaces as an error. */
export async function applyChannelSecret(core: CoreCtx, ctx: ProjectCtx, ref: string, value: string): Promise<void> {
  const v = value.trim();
  if (!v) throw new Error("API key is empty");
  core.secretValues.set(ref, v);
  core.channelService.setSecret(ref, v);
  try {
    await ctx.host.secrets.set(ref, v);
  } catch (e) {
    throw new Error(`key applied for this session but could not be saved to the IDE secret store: ${errorMessage(e)}`);
  }
}

export async function dropChannelSecret(core: CoreCtx, ctx: ProjectCtx, ref: string): Promise<void> {
  core.secretValues.delete(ref);
  core.channelService.setSecret(ref, undefined);
  try {
    await ctx.host.secrets.delete(ref);
  } catch (e) {
    throw new Error(`key removed for this session but could not be deleted from the IDE secret store: ${errorMessage(e)}`);
  }
}

/** User-file item rows preserving unknown fields, else the effective rows materialized (defaults layer). */
export function docItems(ctx: ProjectCtx, file: string, fallback: Record<string, unknown>[]): Record<string, unknown>[] {
  const doc = parseYaml(ctx.userLayer[file] ?? "") as { items?: unknown } | null;
  return Array.isArray(doc?.items) ? (doc.items as Record<string, unknown>[]) : fallback;
}

/** Write `items` to a user file (SelfWriteGuard recorded) only when `changed`. */
export async function writeItems(core: CoreCtx, file: string, items: Record<string, unknown>[], changed: boolean): Promise<void> {
  if (!changed) return;
  const yaml = stringifyYaml({ version: 1, items });
  core.userGuard.recordWrite(file, yaml);
  await core.deps.userConfig.write(file, yaml);
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

/** Merge qualification records into one model's caps on a caps-carrying object (channel def or channel cfg). */
export function mergeQualified(target: { modelCaps: Record<string, { qualified?: Record<string, unknown> }> }, model: string, q: Record<string, unknown>): void {
  const caps = (target.modelCaps[model] ??= {});
  caps.qualified = { ...caps.qualified, ...q };
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

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { applyDecisions, cascadeRemoval, detectIdChange, repointRename, type RawItems } from "@stewart/setup";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { writeItems } from "./util.js";

const CASCADED = new Set(["channels.yaml", "agents.yaml"]);

/**
 * `config.set` follow-up for the user layer: a removed channel removes its agents, a removed
 * agent resets bound roles, and a single id rename re-points references instead of removing.
 * Reads raw user-file rows (`ctx.userLayer` still holds the pre-write snapshot); never
 * materializes shipped defaults into user files. Project-layer roles are unbound/re-pointed
 * too when they bind an affected agent.
 */
export async function cascadeConfigSet(core: CoreCtx, ctx: ProjectCtx, file: string, nextDoc: unknown): Promise<void> {
  if (!CASCADED.has(file)) return;
  const change = detectIdChange(layerItems(ctx.userLayer, file), itemsOf(nextDoc));
  const docs = {
    agents: file === "agents.yaml" ? itemsOf(nextDoc) : layerItems(ctx.userLayer, "agents.yaml"),
    roles: layerItems(ctx.userLayer, "roles.yaml"),
  };
  if (change.renamed || change.removed.length) await applyCascade(core, ctx, { file, docs, change });
}

interface CascadeWork {
  file: string;
  docs: { agents: RawItems; roles: RawItems };
  change: { removed: string[]; renamed?: { from: string; to: string } };
}

async function applyCascade(core: CoreCtx, ctx: ProjectCtx, w: CascadeWork): Promise<void> {
  const res = w.change.renamed
    ? repointRename(w.docs, w.file === "channels.yaml" ? "channel" : "agent", w.change.renamed)
    : cascadeRemoval(w.docs, w.file === "channels.yaml" ? { channels: new Set(w.change.removed) } : { agents: new Set(w.change.removed) });
  await writeItems(core, "agents.yaml", res.agents, changed(res.agents, w.docs.agents));
  await writeItems(core, "roles.yaml", res.roles, changed(res.roles, w.docs.roles));
  await projectRoles(ctx, transformRoles(w, res.removedAgents));
}

/** The role transform a project roles.yaml needs for the same change (channel renames touch no roles). */
function transformRoles(w: CascadeWork, removedAgents: string[]): (roles: RawItems) => RawItems {
  if (w.change.renamed) {
    const kind = w.file === "channels.yaml" ? "channel" : "agent";
    return (roles) => repointRename({ agents: [], roles }, kind, w.change.renamed!).roles;
  }
  return (roles) => applyDecisions({ agents: [], roles, channels: [] }, { removeAgents: new Set(removedAgents) }).roles;
}

/** Project roles.yaml outranks the user file field-by-field; apply the same transform there (trusted workspaces only). */
async function projectRoles(ctx: ProjectCtx, transform: (roles: RawItems) => RawItems): Promise<void> {
  if (!ctx.trusted) return;
  const roles = layerItems(ctx.projectLayer, "roles.yaml");
  if (!roles.length) return;
  const next = transform(roles);
  if (!changed(next, roles)) return;
  const yaml = stringifyYaml({ version: 1, items: next });
  ctx.projectGuard.recordWrite("roles.yaml", yaml);
  await ctx.projectStore.write("roles.yaml", yaml);
}

/** Items of a raw layer file; an unparseable file reads as empty so the cascade never rewrites it. */
function layerItems(layer: Record<string, string | undefined>, file: string): RawItems {
  try {
    return itemsOf(parseYaml(layer[file] ?? ""));
  } catch {
    return [];
  }
}

function itemsOf(doc: unknown): RawItems {
  const items = (doc as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as RawItems).filter((i) => i && typeof i === "object") : [];
}

const changed = (next: RawItems, prev: RawItems): boolean => next.length !== prev.length || next.some((r, i) => r !== prev[i]);

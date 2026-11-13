import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { PROJECT_ID, startCore, type RunOpts } from "./runner.js";
import { createWorkspace, removeWorkspace, type Workspace } from "./workspace.js";

export interface QualVerdict {
  passed: boolean;
  detail?: string;
}

export interface QualRow {
  agent: string;
  channel: string;
  model: string;
  agentQual?: QualVerdict;
  functionQual?: QualVerdict;
  error?: string;
}

export interface Qualified {
  /** Config dir whose channels.yaml holds only records written by this run. */
  config: string;
  rows: QualRow[];
  cleanup(): Promise<void>;
}

interface Items<T> {
  items?: T[];
}

async function readItems<T>(file: string): Promise<{ doc: Items<T> & Record<string, unknown>; items: T[] }> {
  const doc = ((existsSync(file) ? parse(await readFile(file, "utf8")) : null) ?? {}) as Items<T> & Record<string, unknown>;
  return { doc, items: Array.isArray(doc.items) ? doc.items : [] };
}

/** Remove every `qualified` record from channels.yaml so only this run's suites decide eligibility. */
export async function stripQualified(configDir: string): Promise<number> {
  const file = join(configDir, "channels.yaml");
  const { doc, items } = await readItems<{ modelCaps?: Record<string, Record<string, unknown>> }>(file);
  let removed = 0;
  for (const ch of items) {
    for (const caps of Object.values(ch.modelCaps ?? {})) {
      if (caps && "qualified" in caps) {
        delete caps.qualified;
        removed++;
      }
    }
  }
  if (removed) await writeFile(file, stringify(doc));
  return removed;
}

interface AgentItem {
  id: string;
  channel: string;
  model: string;
}

interface RoleItem {
  enabled?: boolean;
  agent?: string;
  chain?: string[];
}

/** Agents an enabled role binds (agent or chain); every agent when no role binds one. */
export async function agentsToQualify(configDir: string): Promise<AgentItem[]> {
  const agents = (await readItems<AgentItem>(join(configDir, "agents.yaml"))).items;
  const roles = (await readItems<RoleItem>(join(configDir, "roles.yaml"))).items;
  const bound = new Set(roles.filter((r) => r.enabled !== false).flatMap((r) => [...(r.chain ?? []), ...(r.agent ? [r.agent] : [])]));
  const picked = bound.size ? agents.filter((a) => bound.has(a.id)) : agents;
  const seen = new Set<string>();
  return picked.filter((a) => {
    const key = `${a.channel}\u0000${a.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type QualifyReply = { agent?: QualVerdict; function?: QualVerdict } | undefined;

export interface QualifyDeps {
  startCore?: typeof startCore;
  createWorkspace?: typeof createWorkspace;
  removeWorkspace?: (ws: Workspace) => Promise<void>;
}

/**
 * Run the real qualification suites (`setup.qualify`) for every agent the config binds, on a copy of the
 * config with all prior `qualified` records removed. Tasks then run on that copy, so an agent takes part
 * only if it passed the suite in this run.
 */
export async function qualifyConfig(configSrc: string, opts: RunOpts, deps: QualifyDeps = {}): Promise<Qualified> {
  const ws = await (deps.createWorkspace ?? createWorkspace)("qualify", configSrc, false);
  await stripQualified(ws.config);
  const { dispatch } = await (deps.startCore ?? startCore)(ws, opts);
  const rows: QualRow[] = [];
  for (const a of await agentsToQualify(ws.config)) {
    const row: QualRow = { agent: a.id, channel: a.channel, model: a.model };
    try {
      const r = (await dispatch("setup.qualify", { projectId: PROJECT_ID, channel: a.channel, model: a.model })) as QualifyReply;
      row.agentQual = r?.agent;
      row.functionQual = r?.function;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
    rows.push(row);
  }
  return { config: ws.config, rows, cleanup: () => (deps.removeWorkspace ?? removeWorkspace)(ws) };
}

function verdict(v?: QualVerdict): string {
  if (!v) return "-";
  return v.passed ? "pass" : `FAIL (${v.detail ?? "no detail"})`;
}

export function formatQualification(rows: QualRow[]): string {
  return rows.map((r) => `qualify ${r.agent.padEnd(28)} agent: ${r.error ? `ERROR (${r.error})` : verdict(r.agentQual)}; function: ${verdict(r.functionQual)}`).join("\n");
}

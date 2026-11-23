import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentDef, Qual } from "@stewart/config";
import type { ManagedChannel } from "@stewart/channels";
import { normalizeReason, qualifyAgent, qualifyFunction, type QualifyDeps } from "@stewart/setup";
import { engineFor, type Engine } from "@stewart/engines";
import { redact } from "@stewart/diagnostics";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { mergeQualified } from "./util.js";

interface QualifiedMap {
  agent?: Qual;
  function?: Qual;
}

/** Synthetic agent for a probe run; `kind` prefixes the id (`qualify:` suites, `smoke:` liveness probe). */
export function agentFor(channel: string, model: string, kind: "qualify" | "smoke" = "qualify"): AgentDef {
  return { id: `${kind}:${channel}:${model}`, channel, model, effort: "medium" };
}

/** The engine serving a channel type: the host-injected one, else the built-in. Single injection point for probe and qualify runs. */
export function engineOf(core: CoreCtx, channelType: string): Engine {
  return core.deps.engineFor?.(channelType) ?? engineFor(channelType);
}

async function runSuites(core: CoreCtx, ctx: ProjectCtx, channelId: string, model: string): Promise<QualifiedMap> {
  const mc = core.channelService.get(channelId);
  const ch = ctx.config.channels.find((c) => c.id === channelId);
  if (!mc || !ch) throw new Error(`unknown channel '${channelId}'`);
  const agent = agentFor(channelId, model);
  const deps: QualifyDeps = {
    clock: core.clock,
    engine: engineOf(core, mc.cfg.type),
    scratch: { host: ctx.host, dir: `${await ctx.host.workspace.stateDir()}/qualify/${randomUUID()}` },
  };
  const [aq, fq] = await Promise.all([qualifyAgent(ch, agent, mc, deps), qualifyFunction(agent, mc, deps)]);
  const secrets = [...core.secretValues.values()];
  const clean = (q?: Qual): Qual | undefined => (q?.detail ? { ...q, detail: redact(normalizeReason(q.detail), secrets) } : q);
  return { agent: clean(aq), function: clean(fq) };
}

function applyQualified(items: Record<string, unknown>[], channel: string, model: string, q: QualifiedMap): boolean {
  const item = items.find((i) => i.id === channel);
  if (!item) return false;
  const caps = ((item.modelCaps ??= {}) as Record<string, Record<string, unknown>>)[model] ??= {};
  const qualified = (caps.qualified ??= {}) as Record<string, unknown>;
  if (q.agent) qualified.agent = q.agent;
  if (q.function) qualified.function = q.function;
  return true;
}

/** Write the qualification records into channels.yaml modelCaps (user file) and the live config. */
export async function persistQualified(core: CoreCtx, ctx: ProjectCtx, ref: { channel: string; model: string }, q: QualifiedMap): Promise<void> {
  const files = await core.deps.userConfig.read();
  const text = files["channels.yaml"];
  if (text === undefined) return;
  const doc = parseYaml(text) as { items?: Record<string, unknown>[] } | null;
  if (!doc || !Array.isArray(doc.items) || !applyQualified(doc.items, ref.channel, ref.model, q)) return;
  const next = stringifyYaml(doc, null, 2);
  core.userGuard.recordWrite("channels.yaml", next);
  await core.deps.userConfig.write("channels.yaml", next);
  const ch = ctx.config.channels.find((c) => c.id === ref.channel);
  if (ch) mergeQualified(ch, ref.model, q as Record<string, unknown>);
  const mc = core.channelService.get(ref.channel);
  if (mc) mergeQualified(mc.cfg as { modelCaps: Record<string, { qualified?: Record<string, unknown> }> }, ref.model, q as Record<string, unknown>);
}

/** Wizard probe hook: qualify a green candidate, stash the full records for setup.approve, return the snapshot booleans. */
export async function qualifyForProbe(core: CoreCtx, ctx: ProjectCtx, channel: string, model: string): Promise<{ agent?: boolean; function?: boolean; detail?: string } | undefined> {
  const q = await runSuites(core, ctx, channel, model);
  const rec = core.qualRecords.get(channel) ?? new Map<string, QualifiedMap>();
  rec.set(model, q);
  core.qualRecords.set(channel, rec);
  return { agent: q.agent?.passed, function: q.function?.passed, detail: q.agent?.detail ?? q.function?.detail };
}

/** Persist every record collected during the wizard probe; called once setup.approve succeeds. */
export async function persistAllQualified(core: CoreCtx, ctx: ProjectCtx): Promise<void> {
  for (const [channel, models] of core.qualRecords) {
    for (const [model, q] of models) await persistQualified(core, ctx, { channel, model }, q);
  }
  core.qualRecords.clear();
}

/** Read-only config view for setup.recommend: unapproved session qualification records overlaid on channel modelCaps. */
export function withSessionQualified(core: CoreCtx, config: EffectiveConfig): EffectiveConfig {
  if (core.qualRecords.size === 0) return config;
  const channels = config.channels.map((ch) => {
    const records = core.qualRecords.get(ch.id);
    if (!records) return ch;
    const caps: typeof ch.modelCaps = {};
    for (const [m, c] of Object.entries(ch.modelCaps)) caps[m] = { ...c };
    const next = { ...ch, modelCaps: caps };
    for (const [model, q] of records) {
      const rec: Record<string, unknown> = {};
      if (q.agent !== undefined) rec.agent = q.agent;
      if (q.function !== undefined) rec.function = q.function;
      mergeQualified(next, model, rec);
    }
    return next;
  });
  return { ...config, channels };
}

export async function handleSetupQualify(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; channel: string; model: string };
  const ctx = core.ctx(p.projectId);
  const q = await runSuites(core, ctx, p.channel, p.model);
  await persistQualified(core, ctx, { channel: p.channel, model: p.model }, q);
  return { agent: q.agent ? { passed: q.agent.passed, detail: q.agent.detail } : undefined, function: q.function ? { passed: q.function.passed, detail: q.function.detail } : undefined };
}

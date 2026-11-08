import { helloSchema, negotiate, PROTOCOL_VERSION, KNOWN_CAPABILITIES } from "@stewart/protocol";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BENCH_VERSION, benchModel, gatherHardware, recommendAssignments, type SetupContext } from "@stewart/setup";
import type { CoreCtx } from "./types.js";
import { applyProbes, catalogFor, workspaceInfoFor } from "./util.js";

export function handleHello(params: unknown): unknown {
  const hello = helloSchema.parse(params);
  const r = negotiate({ protocol: PROTOCOL_VERSION, capabilities: [...KNOWN_CAPABILITIES] }, hello);
  if (!r.ok) throw new Error(r.error);
  return { protocol: PROTOCOL_VERSION, capabilities: r.capabilities };
}

export async function handleChannelTest(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; channelId: string };
  const ch = core.managed.get(p.channelId);
  if (!ch) return { ok: false, error: "channel not configured or disabled" };
  try {
    const models = await ch.listModels();
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleChannelProbe(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; channelId: string; model: string; force?: boolean; bench?: boolean };
  const ctx = core.ctx(p.projectId);
  const ch = core.managed.get(p.channelId);
  if (!ch) return { ok: false, error: "channel not configured or disabled" };
  const cacheKey = `${p.channelId}:${p.model}`;
  const hit = core.probeCache.get(cacheKey);
  if (!p.force && hit && (!p.bench || hit.caps.perf?.benchVersion === BENCH_VERSION)) {
    return { ok: true, caps: hit.caps, probedAt: hit.probedAt, cached: true, catalog: await catalogFor(core, ch, p.model) };
  }
  try {
    const caps = await ch.probeCaps(p.model);
    let perf = hit?.caps.perf;
    if (p.bench && caps.imageGen !== true) {
      perf = await benchModel(ch, p.model, core.clock).catch(() => perf);
    }
    const merged = perf ? { ...caps, perf } : caps;
    const probedAt = core.clock.now();
    core.probeCache.set(cacheKey, { caps: merged, probedAt });
    applyProbes(core, ctx.config);
    return { ok: true, caps: merged, probedAt, cached: false, catalog: await catalogFor(core, ch, p.model) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleSetupRecommend(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as {
    projectId: string;
    mode?: "rules" | "ai";
    evaluator?: { channel: string; model: string };
    context?: { priorities?: { speed?: number; cost?: number; quality?: number }; typicalWork?: string };
    bench?: boolean;
  };
  const ctx = core.ctx(p.projectId);
  if (p.bench) {
    for (const c of ctx.config.channels.filter((c) => c.enabled)) {
      const ch = core.managed.get(c.id);
      if (!ch) continue;
      let models: string[] = [];
      try {
        models = [...new Set([...(await ch.listModels()), ...(c.extraModels ?? [])])];
      } catch {
        continue;
      }
      for (const model of models) {
        const hit = core.probeCache.get(`${c.id}:${model}`);
        if (hit?.caps.imageGen === true || c.modelCaps?.[model]?.perf?.benchVersion === BENCH_VERSION) continue;
        if (hit?.caps.perf?.benchVersion === BENCH_VERSION) continue;
        await handleChannelProbe(core, { projectId: p.projectId, channelId: c.id, model, bench: true });
      }
    }
  }
  const clamp = (n: unknown): 1 | 2 | 3 => (n === 1 || n === 3 ? n : 2);
  if (p.context?.priorities || p.context?.typicalWork) {
    const raw = (await core.deps.userConfig.read())["settings.yaml"] ?? "";
    const doc = (parseYaml(raw.trim() ? raw : "version: 1\n") ?? {}) as Record<string, unknown>;
    if (p.context.priorities) {
      doc.setupPriorities = {
        speed: clamp(p.context.priorities.speed),
        cost: clamp(p.context.priorities.cost),
        quality: clamp(p.context.priorities.quality),
      };
    }
    if (p.context.typicalWork) doc.setupTypicalWork = p.context.typicalWork;
    const yaml = stringifyYaml(doc);
    core.userGuard.recordWrite("settings.yaml", yaml);
    await core.deps.userConfig.write("settings.yaml", yaml);
    await core.reload(p.projectId);
  }
  const context: Partial<SetupContext> = {
    ...(p.context?.priorities
      ? { priorities: { speed: clamp(p.context.priorities.speed), cost: clamp(p.context.priorities.cost), quality: clamp(p.context.priorities.quality) } }
      : ctx.config.settings.setupPriorities
        ? { priorities: ctx.config.settings.setupPriorities }
        : {}),
    ...(p.context?.typicalWork ? { typicalWork: p.context.typicalWork as SetupContext["typicalWork"] } : ctx.config.settings.setupTypicalWork ? { typicalWork: ctx.config.settings.setupTypicalWork } : {}),
    workspace: await workspaceInfoFor(core, ctx, p.projectId),
    hardware: await gatherHardware(ctx.host).catch(() => undefined),
  };
  return recommendAssignments(ctx.config, core.managed, {
    mode: p.mode,
    evaluator: p.evaluator,
    context,
    priceFor: async (channelId, model) => {
      const ch = core.managed.get(channelId);
      return ch ? catalogFor(core, ch, model) : undefined;
    },
  });
}

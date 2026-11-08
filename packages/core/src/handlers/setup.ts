import { helloSchema, negotiate, PROTOCOL_VERSION, KNOWN_CAPABILITIES } from "@stewart/protocol";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BENCH_VERSION, benchModel, gatherHardware, recommendAssignments, SetupSession, type SetupContext, type SetupSessionDeps } from "@stewart/setup";
import { CONFIG_FILE_SCHEMAS } from "@stewart/config";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { applyProbes, catalogFor, workspaceInfoFor } from "./util.js";

const sessions = new Map<string, SetupSession>();

async function sessionDeps(core: CoreCtx, ctx: ProjectCtx, projectId: string): Promise<SetupSessionDeps> {
  const stateDir = await ctx.host.workspace.stateDir();
  return {
    files: ctx.host.files,
    stateDir,
    readUserFiles: () => core.deps.userConfig.read(),
    writeUserFile: async (name, yaml) => {
      core.userGuard.recordWrite(name, yaml);
      await core.deps.userConfig.write(name, yaml);
    },
    validateFiles: (files) => {
      for (const [name, yaml] of Object.entries(files)) {
        const schema = CONFIG_FILE_SCHEMAS[name];
        if (!schema) return `unknown config file: ${name}`;
        let doc: unknown;
        try {
          doc = parseYaml(yaml);
        } catch (e) {
          return `${name}: invalid YAML: ${e instanceof Error ? e.message : e}`;
        }
        const parsed = schema.safeParse(doc ?? {});
        if (!parsed.success) return `${name}: ${parsed.error.issues[0]?.message ?? "schema error"}`;
      }
      return undefined;
    },
    deleteSecret: async (ref) => {
      await ctx.host.secrets.delete(ref);
      core.secretValues.delete(ref);
      core.channelService.setSecret(ref, undefined);
    },
    onEvent: (ev) => core.deps.emitEvent({ kind: "setup.event", projectId, event: ev }),
  };
}

async function sessionFor(core: CoreCtx, p: { projectId: string }): Promise<{ ctx: ProjectCtx; session: SetupSession }> {
  const ctx = core.ctx(p.projectId);
  let s = sessions.get(p.projectId);
  if (!s || s.phase === "cancelled" || s.phase === "saved") {
    s = await SetupSession.open(await sessionDeps(core, ctx, p.projectId));
    sessions.set(p.projectId, s);
  }
  return { ctx, session: s };
}

const publicState = (s: SetupSession) => ({ phase: s.phase, draft: s.state });

export async function handleSetupSessionStart(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  return publicState(session);
}
export async function handleSetupSessionGet(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  return publicState(session);
}
export async function handleSetupSessionUpdate(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; patch: Record<string, unknown> };
  const { session } = await sessionFor(core, p);
  return { phase: session.phase, draft: await session.update(p.patch) };
}
export async function handleSetupSessionAdvance(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  return session.advance();
}
export async function handleSetupSessionBack(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  return session.back();
}
export async function handleSetupSessionCancel(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  await session.cancel();
  return { ok: true };
}
export async function handleSetupReview(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  return session.review();
}
export async function handleSetupApprove(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; token: string };
  const { session } = await sessionFor(core, p);
  const res = await session.approveAndSave(p.token);
  if (res.ok) await core.reload(p.projectId);
  return res;
}
export async function handleSetupUndo(core: CoreCtx, params: unknown): Promise<unknown> {
  const { session } = await sessionFor(core, params as { projectId: string });
  const res = await session.undo();
  const p = params as { projectId: string };
  if (res.ok) await core.reload(p.projectId);
  return res;
}

export function handleHello(params: unknown): unknown {
  const hello = helloSchema.parse(params);
  const r = negotiate({ protocol: PROTOCOL_VERSION, capabilities: [...KNOWN_CAPABILITIES] }, hello);
  if (!r.ok) throw new Error(r.error);
  return { protocol: PROTOCOL_VERSION, capabilities: r.capabilities };
}

export async function handleChannelTest(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; channelId: string };
  const ch = core.channelService.get(p.channelId);
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
  const ch = core.channelService.get(p.channelId);
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
      perf = await benchModel(ch, p.model, core.clock, core.probeLoop).catch(() => perf);
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
      const ch = core.channelService.get(c.id);
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
  return recommendAssignments(ctx.config, core.channelService, {
    mode: p.mode,
    evaluator: p.evaluator,
    context,
    priceFor: async (channelId, model) => {
      const ch = core.channelService.get(channelId);
      return ch ? catalogFor(core, ch, model) : undefined;
    },
  });
}

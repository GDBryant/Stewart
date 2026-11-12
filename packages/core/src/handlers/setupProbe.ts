import { fallbackOrder, modelSizeB, normalizeReason, orderSmokeCandidates, rankCandidates, SetupProbeRunner, type RankCandidate, type SmokeCandidate } from "@stewart/setup";
import { resolveModelProfile } from "@stewart/models";
import { redact } from "@stewart/diagnostics";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { qualifyForProbe } from "./qualify.js";

interface RichCandidate extends SmokeCandidate {
  channelType: string;
  hasAgent: boolean;
  sizeB?: number;
}

function probeRunnerFor(core: CoreCtx, projectId: string): SetupProbeRunner {
  let r = core.probeRunners.get(projectId);
  if (!r) {
    let self!: SetupProbeRunner;
    self = new SetupProbeRunner({
      channelFor: (id) => core.channelService.get(id),
      onEvent: (ev) => {
        if (core.probeRunners.get(projectId) === self) core.deps.emitEvent({ kind: "setup.event", projectId, event: ev });
      },
      now: () => core.clock.now(),
      qualify: (c) => qualifyForProbe(core, core.ctx(projectId), c.channel, c.model),
      sanitizeReason: (reason) => redact(normalizeReason(reason), [...core.secretValues.values()]),
    });
    r = self;
    core.probeRunners.set(projectId, r);
  }
  return r;
}

/** All enabled channel models (webview-provided list validated, or live discovery), deduped, with agent/size metadata. */
async function gatherSmokeCandidates(core: CoreCtx, ctx: ProjectCtx, provided?: { channel: string; model: string }[]): Promise<RichCandidate[]> {
  const enabled = ctx.config.channels.filter((c) => c.enabled);
  const byId = new Map(enabled.map((c) => [c.id, c]));
  const agentPairs = new Set(ctx.config.agents.map((a) => `${a.channel}:${a.model}`));
  const out = new Map<string, RichCandidate>();
  const push = (channel: string, model: string) => {
    const ch = byId.get(channel);
    const k = `${channel}:${model}`;
    if (!ch || out.has(k) || !core.channelService.get(channel)) return;
    out.set(k, { channel, model, channelType: ch.type, hasAgent: agentPairs.has(k), sizeB: modelSizeB(model) });
  };
  if (provided?.length) {
    for (const c of provided) push(c.channel, c.model);
    return [...out.values()];
  }
  await Promise.all(
    enabled.map(async (c) => {
      const mc = core.channelService.get(c.id);
      let models: string[] = [];
      if (mc) {
        try {
          models = await mc.listModels();
        } catch {
          models = [];
        }
      }
      for (const m of new Set([...models, ...(c.extraModels ?? [])])) push(c.id, m);
    }),
  );
  return [...out.values()];
}

function candidateDetail(config: ProjectCtx["config"], c: RichCandidate): string {
  const caps = resolveModelProfile(config, { channel: c.channel, model: c.model }).caps;
  const parts: string[] = [];
  if (caps.tools) parts.push(`tools=${caps.tools}`);
  if (caps.vision) parts.push("vision");
  if (caps.reasoning) parts.push("reasoning");
  if (caps.imageGen) parts.push("imageGen");
  if (caps.contextTokens !== undefined) parts.push(`${Math.round(caps.contextTokens / 1000)}k ctx`);
  if (c.sizeB !== undefined) parts.push(`~${c.sizeB}B`);
  return parts.join(", ");
}

/** Evaluator-ranked tail order; falls back to deterministic order on any failure. Never rejects. */
function rankSmokeRest(core: CoreCtx, ctx: ProjectCtx, rest: RichCandidate[], evaluator?: { channel: string; model: string }): Promise<SmokeCandidate[]> {
  const fallback = () => fallbackOrder(rest).map(({ channel, model }) => ({ channel, model }));
  if (!rest.length || !evaluator) return Promise.resolve(fallback());
  const mc = core.channelService.get(evaluator.channel);
  if (!mc) return Promise.resolve(fallback());
  const ranked: RankCandidate[] = rest.map((c) => ({ ...c, detail: candidateDetail(ctx.config, c) }));
  return rankCandidates(ranked, mc, evaluator.model)
    .then((r) => r ?? fallback())
    .catch(() => fallback());
}

/** Fingerprint of enabled channels, the candidate set and the evaluator; any change starts a new run. */
function probeSignature(ctx: ProjectCtx, cands: RichCandidate[], evaluator?: { channel: string; model: string }): string {
  const channels = ctx.config.channels
    .filter((c) => c.enabled)
    .map((c) => `${c.id}:${c.type}:${c.baseUrl ?? ""}`)
    .sort()
    .join(",");
  const models = cands
    .map((c) => `${c.channel}:${c.model}`)
    .sort()
    .join(",");
  const evalKey = evaluator ? `${evaluator.channel}:${evaluator.model}` : "";
  return `${channels}|${models}|${evalKey}`;
}

export async function handleSetupProbeStart(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; candidates?: { channel: string; model: string }[]; evaluator?: { channel: string; model: string }; retry?: boolean };
  const ctx = core.ctx(p.projectId);
  const runner = probeRunnerFor(core, p.projectId);
  if (p.retry) return runner.retry();
  const cands = await gatherSmokeCandidates(core, ctx, p.candidates);
  const { priority, rest } = orderSmokeCandidates(cands);
  return runner.start({ signature: probeSignature(ctx, cands, p.evaluator), priority, rest: rankSmokeRest(core, ctx, rest, p.evaluator) });
}
export async function handleSetupProbeStatus(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  return probeRunnerFor(core, p.projectId).snapshot();
}
export async function handleSetupProbeCancel(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  return probeRunnerFor(core, p.projectId).cancel();
}
export async function handleSetupProbeRetry(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  return probeRunnerFor(core, p.projectId).retry();
}

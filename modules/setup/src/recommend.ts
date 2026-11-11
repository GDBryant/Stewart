import type { EffectiveConfig } from "@stewart/roles-skills";
import type { ChatEvent, ChatRequest } from "@stewart/channels";
import { scoreAssignments, type Candidate, type Unfilled } from "./assign.js";
import { buildRecommendPrompt } from "./recommendPrompt.js";
import { asStr, hardRefusal, modelRefusal, roleRefusal } from "./recommendRefusals.js";
import { blendedCost, costTier, type ModelInfo } from "@stewart/catalog";
import type { SetupContext } from "./setupContext.js";
import { resolveModelProfile } from "@stewart/models";

export interface RecommendChannelInfo {
  id: string;
  type: string;
  models: string[];
  error?: string;
}

export interface Assignment {
  role: string;
  channel: string;
  model: string;
  reason?: string;
  score?: number;
  warnings?: string[];
  source?: "rules" | "ai";
}

export interface RecommendOptions {
  /** `rules` = deterministic only (no model call). `ai` (default) = evaluator model refines. */
  mode?: "rules" | "ai";
  evaluator?: { channel: string; model: string };
  /** Environment/workload facts; priorities reweight the scorer. */
  context?: Partial<SetupContext>;
  /** Resolves live/catalog price info per model (agent.price always wins over it). */
  priceFor?: (channel: string, model: string) => Promise<ModelInfo | undefined>;
  /** Restrict candidates to these channel:model pairs (e.g. smoke-tested green), in preference order. */
  eligible?: { channel: string; model: string }[];
  /** Allow opts.evaluator even when it is outside `eligible`. */
  evaluatorAny?: boolean;
}

export type RecommendResult =
  | {
      ok: true;
      assignments: Assignment[];
      researcher?: { channel: string; model: string };
      channels: RecommendChannelInfo[];
      dropped?: string[];
      unfilled?: Unfilled[];
    }
  | { ok: false; error: string; raw?: string; channels?: RecommendChannelInfo[]; dropped?: string[] };

export interface RecommendChannel {
  listModels(): Promise<string[]>;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
}

/**
 * Discover models on every enabled channel, ask one reachable model to pick the
 * best model per role, then validate the answer against what was discovered.
 * Never writes config — the webview applies the proposal explicitly.
 */
export async function recommendAssignments(
  config: EffectiveConfig,
  managed: { get(id: string): RecommendChannel | undefined },
  opts: RecommendOptions = {},
): Promise<RecommendResult> {
  const channels = await discoverChannels(config, managed);
  const allModels = new Map(channels.map((c) => [c.id, new Set(c.models)]));
  if (opts.eligible) {
    const ok = new Set(opts.eligible.map((e) => `${e.channel}:${e.model}`));
    for (const c of channels) c.models = c.models.filter((m) => ok.has(`${c.id}:${m}`));
  }
  if (!channels.some((c) => c.models.length)) {
    return {
      ok: false,
      error: opts.eligible ? "no models passed the smoke test; retry probes or check channels" : "no models discovered; check channels",
      channels,
    };
  }

  const candidates = await buildCandidates(config, channels, opts);
  const rules = scoreAssignments(config.roles.map((r) => r.id), candidates, opts.context);
  if (opts.mode === "rules") {
    return { ok: true, assignments: rules.assignments, channels, unfilled: rules.unfilled };
  }
  const researcher = pickResearcher(config, channels, allModels, opts);
  const prompt = buildRecommendPrompt({ config, channels, candidates, rules, context: opts.context });

  const mc = managed.get(researcher.channel)!;
  let text = "";
  try {
    for await (const ev of mc.chat({ model: researcher.model, messages: [{ role: "user", content: prompt }], signal: AbortSignal.timeout(60_000) })) {
      if (ev.kind === "text") text += ev.text;
    }
  } catch (e) {
    return { ok: false, error: `researcher failed: ${e instanceof Error ? e.message : String(e)}`, channels };
  }

  return parseAndValidate(text, { config, channels, candidates, researcher, unfilled: rules.unfilled });
}

async function discoverChannels(
  config: EffectiveConfig,
  managed: { get(id: string): RecommendChannel | undefined },
): Promise<RecommendChannelInfo[]> {
  const channels: RecommendChannelInfo[] = [];
  for (const c of config.channels) {
    if (!c.enabled) continue;
    const mc = managed.get(c.id);
    if (!mc) {
      channels.push({ id: c.id, type: c.type, models: [...(c.extraModels ?? [])], error: "not configured" });
      continue;
    }
    try {
      const models = [...new Set([...(await mc.listModels()), ...(c.extraModels ?? [])])];
      channels.push({ id: c.id, type: c.type, models });
    } catch (e) {
      channels.push({ id: c.id, type: c.type, models: [...(c.extraModels ?? [])], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return channels;
}

async function buildCandidates(config: EffectiveConfig, channels: RecommendChannelInfo[], opts: RecommendOptions): Promise<Candidate[]> {
  const candidates: Candidate[] = channels.flatMap((c) =>
    c.models.map((model) => ({ channel: c.id, channelType: c.type, model, caps: resolveModelProfile(config, { channel: c.id, model }).caps })),
  );
  if (opts.eligible) {
    const rank = new Map(opts.eligible.map((e, i) => [`${e.channel}:${e.model}`, i]));
    candidates.sort((a, b) => (rank.get(`${a.channel}:${a.model}`) ?? Number.MAX_SAFE_INTEGER) - (rank.get(`${b.channel}:${b.model}`) ?? Number.MAX_SAFE_INTEGER));
  }
  const agentPrice = new Map(config.agents.filter((a) => a.price).map((a) => [`${a.channel}:${a.model}`, a.price!]));
  await Promise.all(
    candidates.map(async (c) => {
      const own = agentPrice.get(`${c.channel}:${c.model}`);
      if (own) c.price = own;
      else {
        const info = await opts.priceFor?.(c.channel, c.model);
        if (info) {
          c.price = { inPerMTok: info.inPerMTok, outPerMTok: info.outPerMTok };
          if (c.caps.contextTokens === undefined && info.contextTokens !== undefined) {
            c.caps = { ...c.caps, contextTokens: info.contextTokens };
          }
        }
      }
      c.costBlended = blendedCost(c.price);
      c.costTier = costTier(c.costBlended);
    }),
  );
  return candidates;
}

function pickResearcher(
  config: EffectiveConfig,
  channels: RecommendChannelInfo[],
  allModels: Map<string, Set<string>>,
  opts: RecommendOptions,
): { channel: string; model: string } {
  const byId = new Map(channels.map((c) => [c.id, c]));
  let researcher: { channel: string; model: string } | undefined;
  const hasModel = (channel: string, model: string) =>
    opts.evaluatorAny ? allModels.get(channel)?.has(model) === true : byId.get(channel)?.models.includes(model) === true;
  if (opts.evaluator && hasModel(opts.evaluator.channel, opts.evaluator.model)) researcher = opts.evaluator;
  for (const a of researcher ? [] : config.agents) {
    const info = byId.get(a.channel);
    if (info?.models.includes(a.model)) {
      researcher = { channel: a.channel, model: a.model };
      break;
    }
  }
  if (!researcher) {
    const first = channels.find((c) => c.models.length)!;
    researcher = { channel: first.id, model: first.models[0] };
  }
  return researcher;
}

/** Inputs the researcher answer is validated against. */
interface ValidateContext {
  config: EffectiveConfig;
  channels: RecommendChannelInfo[];
  candidates: Candidate[];
  researcher: { channel: string; model: string };
  unfilled: Unfilled[];
}

/** Parses the first `{` .. last `}` span of `text` as JSON; undefined when absent or malformed. */
export function parseJsonObject(text: string): { assignments?: unknown } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { assignments?: unknown };
  } catch {
    return undefined;
  }
}

function parseAndValidate(text: string, ctx: ValidateContext): RecommendResult {
  const { config, channels, candidates, researcher, unfilled } = ctx;
  const byId = new Map(channels.map((c) => [c.id, c]));
  const cand = new Map(candidates.map((c) => [`${c.channel}:${c.model}`, c]));
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return { ok: false, error: "could not parse recommendation", raw: text.slice(0, 500), channels };
  }

  const roleIds = new Set(config.roles.map((r) => r.id));
  const dropped: string[] = [];
  const assignments: Assignment[] = [];
  for (const e of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const result = validateAssignment(e, roleIds, byId, cand);
    if (result.assignment) assignments.push(result.assignment);
    else dropped.push(result.dropped);
  }
  if (!assignments.length) {
    return { ok: false, error: "recommendation was empty or invalid", channels, dropped };
  }
  return { ok: true, assignments, researcher, channels, dropped, unfilled };
}

function validateAssignment(
  e: unknown,
  roleIds: Set<string>,
  byId: Map<string, RecommendChannelInfo>,
  cand: Map<string, Candidate>,
): { assignment: Assignment; dropped?: never } | { assignment?: never; dropped: string } {
  const a = (e ?? {}) as Record<string, unknown>;
  const role = asStr(a.role);
  const channel = asStr(a.channel);
  const model = asStr(a.model);
  const dropped = roleRefusal(role, roleIds) ?? modelRefusal(role, channel, model, byId) ?? hardRefusal(role, channel, model, cand);
  if (dropped) return { dropped };
  return { assignment: { role, channel, model, reason: typeof a.reason === "string" ? a.reason : undefined } };
}


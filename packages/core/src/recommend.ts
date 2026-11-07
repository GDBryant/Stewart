import type { Config } from "./config/loader.js";
import type { ChatEvent, ChatRequest } from "./channels/types.js";
import { meetsHardRequirements, ROLE_PROFILES, scoreAssignments, type Candidate, type Unfilled } from "./assign.js";
import { blendedCost, costTier, type ModelInfo } from "@stewart/catalog";
import type { SetupContext } from "./setupContext.js";
import { resolveModelProfile } from "./modelProfile.js";

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

const CAP_KEYS = ["tools", "vision", "reasoning", "imageGen", "contextTokens"] as const;

/**
 * Discover models on every enabled channel, ask one reachable model to pick the
 * best model per role, then validate the answer against what was discovered.
 * Never writes config — the webview applies the proposal explicitly.
 */
export async function recommendAssignments(
  config: Config,
  managed: { get(id: string): RecommendChannel | undefined },
  opts: RecommendOptions = {},
): Promise<RecommendResult> {
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
  if (!channels.some((c) => c.models.length)) {
    return { ok: false, error: "no models discovered; check channels", channels };
  }

  const byId = new Map(channels.map((c) => [c.id, c]));
  const candidates: Candidate[] = channels.flatMap((c) =>
    c.models.map((model) => ({ channel: c.id, channelType: c.type, model, caps: resolveModelProfile(config, { channel: c.id, model }).caps })),
  );
  const cand = new Map(candidates.map((c) => [`${c.channel}:${c.model}`, c]));
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
  const rules = scoreAssignments(config.roles.map((r) => r.id), candidates, opts.context);
  if (opts.mode === "rules") {
    return { ok: true, assignments: rules.assignments, channels, unfilled: rules.unfilled };
  }
  let researcher: { channel: string; model: string } | undefined;
  if (opts.evaluator && byId.get(opts.evaluator.channel)?.models.includes(opts.evaluator.model)) researcher = opts.evaluator;
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

  const roleLines = config.roles
    .map((r) => {
      const t = ROLE_PROFILES[r.id]?.typicalTurns;
      return `- ${r.id}${t ? ` (~${t[0]}-${t[1]} turns)` : ""}: ${(r.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`;
    })
    .join("\n");
  const chanLines = channels
    .map((c) => {
      const models = c.models
        .map((m) => {
          const caps = resolveModelProfile(config, { channel: c.id, model: m }).caps;
          const parts = CAP_KEYS.filter((k) => caps[k] !== undefined).map((k) => `${k}=${caps[k]}`);
          const perf = caps.perf;
          if (perf?.tokPerSec !== undefined) parts.push(`${Math.round(perf.tokPerSec)}tok/s`);
          if (perf?.toolReliability !== undefined) parts.push(`tool=${Math.round(perf.toolReliability * 3)}/3`);
          if (perf?.editOk !== undefined) parts.push(`edit=${perf.editOk}`);
          const cd = cand.get(`${c.id}:${m}`);
          if (cd?.costBlended !== undefined) parts.push(`$${cd.costBlended.toFixed(2)}/MTok(${cd.costTier})`);
          return parts.length ? `${m} (${parts.join(", ")})` : m;
        })
        .join("; ");
      return `- ${c.id} (${c.type})${c.error ? ` [listModels failed: ${c.error}]` : ""}: ${models}`;
    })
    .join("\n");
  const sc = opts.context;
  const ctxLines = [
    sc?.workspace ? `- workspace: ${sc.workspace.sizeClass} (${sc.workspace.files} files, ~${sc.workspace.loc} loc${sc.workspace.monorepo ? ", monorepo" : ""})` : "",
    sc?.hardware ? `- hardware: ${sc.hardware.os}, ${sc.hardware.ramGb}GB RAM${sc.hardware.gpus?.length ? `, GPU ${sc.hardware.gpus.map((g) => `${g.name} ${g.vramGb}GB`).join("/")}` : ""}` : "",
    sc?.priorities ? `- priorities (1-3): speed ${sc.priorities.speed}, cost ${sc.priorities.cost}, quality ${sc.priorities.quality}` : "",
    sc?.typicalWork ? `- typical work: ${sc.typicalWork}` : "",
  ].filter(Boolean);
  const ctxBlock = ctxLines.length ? `\nContext:\n${ctxLines.join("\n")}\n` : "";
  const prompt = [
    "You are assigning models to agent roles for a coding assistant.",
    "",
    "Roles:",
    roleLines,
    "",
    "Available channels and discovered models (known capabilities in parentheses):",
    chanLines,
    ctxBlock,
    "",
    'Return ONLY a JSON object {"assignments":[{"role":"roleId","channel":"channelId","model":"model","reason":"short"}]}.',
    "A deterministic scorer proposed this baseline (keep it unless you have a clear reason):",
    rules.assignments.map((a) => `- ${a.role}: ${a.channel}:${a.model}`).join("\n") || "(none)",
    "",
    "Choose the best model for each role. Every role must appear; channel and model must come from the candidates above.",
    "Prefer reasoning models for orchestrator, planner and plan-validator; vision-capable models for image-reader; imageGen for image-writer; strong tool-use coding models for code-writer, general-worker and tester; cheaper fast models are acceptable for document-writer.",
  ].join("\n");

  const mc = managed.get(researcher.channel)!;
  let text = "";
  try {
    for await (const ev of mc.chat({ model: researcher.model, messages: [{ role: "user", content: prompt }], signal: AbortSignal.timeout(60_000) })) {
      if (ev.kind === "text") text += ev.text;
    }
  } catch (e) {
    return { ok: false, error: `researcher failed: ${e instanceof Error ? e.message : String(e)}`, channels };
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let parsed: { assignments?: unknown } | undefined;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1)) as { assignments?: unknown };
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed) {
    return { ok: false, error: "could not parse recommendation", raw: text.slice(0, 500), channels };
  }

  const roleIds = new Set(config.roles.map((r) => r.id));
  const dropped: string[] = [];
  const assignments: Assignment[] = [];
  for (const e of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const a = (e ?? {}) as Record<string, unknown>;
    const role = typeof a.role === "string" ? a.role : "";
    const channel = typeof a.channel === "string" ? a.channel : "";
    const model = typeof a.model === "string" ? a.model : "";
    if (!roleIds.has(role)) {
      dropped.push(`${role || "?"}: unknown role`);
      continue;
    }
    const info = byId.get(channel);
    if (!info) {
      dropped.push(`${role}: unknown channel '${channel}'`);
      continue;
    }
    if (!info.models.includes(model)) {
      dropped.push(`${role}: unknown model '${model}' on ${channel}`);
      continue;
    }
    const c = cand.get(`${channel}:${model}`);
    if (c && !meetsHardRequirements(role, c)) {
      dropped.push(`${role}: ${channel}:${model} fails hard requirements`);
      continue;
    }
    assignments.push({ role, channel, model, reason: typeof a.reason === "string" ? a.reason : undefined });
  }
  if (!assignments.length) {
    return { ok: false, error: "recommendation was empty or invalid", channels, dropped };
  }
  return { ok: true, assignments, researcher, channels, dropped, unfilled: rules.unfilled };
}

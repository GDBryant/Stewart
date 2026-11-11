import type { ModelCaps } from "@stewart/models";
import type { SetupContext } from "./setupContext.js";

/** One selectable model with whatever capabilities are known. */
export interface Candidate {
  channel: string;
  channelType: string;
  model: string;
  caps: Partial<ModelCaps>;
  /** USD per MTok (user-set agent.price wins, then live, then catalog). Undefined = unknown. */
  price?: { inPerMTok?: number; outPerMTok?: number };
  costBlended?: number;
  costTier?: "free" | "low" | "mid" | "high";
}

export interface ScoredAssignment {
  role: string;
  channel: string;
  model: string;
  reason: string;
  score: number;
  warnings: string[];
  source: "rules";
}

export interface Unfilled {
  role: string;
  reason: string;
}

interface Profile {
  /** Hard: candidate is ineligible without these. */
  needs?: { tools?: boolean; vision?: boolean; imageGen?: boolean };
  /** Soft requirement: still assignable, but with a warning. */
  minCtx?: number;
  minSizeB?: number;
  wantsReasoning?: boolean;
  wantsCoder?: boolean;
  /** Prefer smaller/faster models. */
  cheap?: boolean;
  /** Does a human wait on this role? Interactive weights speed harder. Default: batch. */
  latency?: "interactive" | "batch";
  /** Expected tool turns, shown to the AI evaluator. */
  typicalTurns?: [number, number];
  /** Requires a passing edit bench when measured. */
  needsEdit?: boolean;
  /** Hard filter when perf is known, warning when unknown. */
  minToolReliability?: number;
  /** How hard the cost penalty weighs. Default: medium. */
  costSensitivity?: "low" | "medium" | "high";
  /** Many instances at once → prefer cheap/fast. */
  parallelism?: "high" | "low";
}

export const ROLE_PROFILES: Record<string, Profile> = {
  orchestrator: { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true, latency: "batch", typicalTurns: [3, 8], costSensitivity: "low" },
  planner: { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true, latency: "batch", typicalTurns: [3, 8], costSensitivity: "low" },
  "plan-validator": { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true, latency: "batch", typicalTurns: [1, 4], costSensitivity: "low" },
  investigator: { needs: { tools: true }, minCtx: 16384, latency: "interactive", typicalTurns: [5, 20], costSensitivity: "high", parallelism: "high" },
  architect: { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true, latency: "batch", typicalTurns: [3, 8], costSensitivity: "low" },
  "general-worker": { needs: { tools: true }, minCtx: 16384, wantsCoder: true, latency: "batch", typicalTurns: [10, 40], needsEdit: true, minToolReliability: 0.67, costSensitivity: "medium" },
  "code-writer": { needs: { tools: true }, minCtx: 16384, minSizeB: 7, wantsCoder: true, latency: "batch", typicalTurns: [10, 40], needsEdit: true, minToolReliability: 0.67, costSensitivity: "medium" },
  "code-reviewer": { needs: { tools: true }, minCtx: 16384, wantsReasoning: true, latency: "batch", typicalTurns: [5, 15], costSensitivity: "medium" },
  "code-health-reviewer": { needs: { tools: true }, minCtx: 16384, wantsReasoning: true, latency: "batch", typicalTurns: [5, 15], costSensitivity: "medium" },
  tester: { needs: { tools: true }, minCtx: 16384, wantsCoder: true, latency: "batch", typicalTurns: [10, 40], needsEdit: true, minToolReliability: 0.67, costSensitivity: "medium" },
  "document-writer": { cheap: true, latency: "interactive", typicalTurns: [1, 5], costSensitivity: "high" },
  "image-reader": { needs: { vision: true }, latency: "interactive", typicalTurns: [1, 5], costSensitivity: "medium" },
  "image-writer": { needs: { imageGen: true }, latency: "interactive", typicalTurns: [1, 3], costSensitivity: "medium" },
};

const DEFAULT_PROFILE: Profile = { needs: { tools: true }, latency: "interactive", typicalTurns: [1, 10], costSensitivity: "medium" };

/** Scoring weights for the perf/cost terms; one place so tests can pin them. */
export const SCORE_WEIGHTS = {
  interactiveSpeed: 3,
  batchSpeed: 1,
  costPerTier: { low: 1, medium: 2, high: 4 },
  reliability: 2,
  edit: 1.5,
  parallelismCost: 1.5,
} as const;

/** Parameter count in billions from a model name (`gemma4:e4b` → 4, `qwen3:30b-a3b` → 30). */
export function modelSizeB(name: string): number | undefined {
  const m = /(?:^|[^a-z0-9])e?(\d+(?:\.\d+)?)b(?![a-z])/i.exec(name);
  return m ? Number(m[1]) : undefined;
}

function effectiveSize(c: Candidate): number | undefined {
  const s = modelSizeB(c.model);
  if (s !== undefined) return s;
  // Hosted models without a size in the name are assumed large; local ones unknown.
  return c.channelType === "ollama" ? undefined : 70;
}

const CODER = /coder|code|devstral|codestral|deepseek|qwen.*instruct/i;

function eligible(c: Candidate, p: Profile): string | undefined {
  return capabilityRefusal(c, p) ?? perfRefusal(c, p);
}

function capabilityRefusal(c: Candidate, p: Profile): string | undefined {
  if (p.needs?.tools && c.caps.tools === "none") return "no tool support";
  if (p.needs?.vision && c.caps.vision !== true) return "no vision";
  if (p.needs?.imageGen && c.caps.imageGen !== true) return "no image generation";
  return undefined;
}

function perfRefusal(c: Candidate, p: Profile): string | undefined {
  const perf = c.caps.perf;
  if (p.needsEdit && perf?.editOk === false) return "failed edit bench";
  if (p.minToolReliability !== undefined && perf?.toolReliability !== undefined && perf.toolReliability < p.minToolReliability) {
    return `tool reliability ${perf.toolReliability} < ${p.minToolReliability}`;
  }
  return undefined;
}

/** True when the candidate meets the role's hard requirements. */
export function meetsHardRequirements(role: string, c: Candidate): boolean {
  return eligible(c, ROLE_PROFILES[role] ?? DEFAULT_PROFILE) === undefined;
}

/** One scoring dimension's contribution: score delta plus human-readable reason/warning strings. */
interface Term {
  delta: number;
  why: string[];
  warnings: string[];
}

const term = (delta = 0, why: string[] = [], warnings: string[] = []): Term => ({ delta, why, warnings });

function sizeScore(p: Profile, size: number | undefined, q: number): Term {
  if (size === undefined) return p.minSizeB ? term(0, [], ["model size unknown"]) : term();
  const sz = Math.min(Math.log2(Math.max(size, 1) / 2), 6);
  const t = p.cheap ? term(3 - Math.abs(sz - 2), ["fast/cheap"]) : term(sz * q);
  if (p.minSizeB && size < p.minSizeB) {
    t.delta -= 4;
    t.warnings.push(`model is ~${size}B; ${p.minSizeB}B+ recommended for this role`);
  }
  return t;
}

function capabilityScore(c: Candidate, p: Profile, q: number): Term {
  const why: string[] = [];
  let delta = 0;
  if (c.caps.tools === "native") {
    delta += 2;
    why.push("native tools");
  }
  if (p.wantsReasoning && c.caps.reasoning) {
    delta += 3 * q;
    why.push("reasoning");
  }
  if (p.wantsCoder && CODER.test(c.model)) {
    delta += 2 * q;
    why.push("coding model");
  }
  if (p.needs?.vision && c.caps.vision) why.push("vision");
  if (p.needs?.imageGen && c.caps.imageGen) why.push("image generation");
  return term(delta, why);
}

function contextScore(c: Candidate, p: Profile): Term {
  const numCtx = c.caps.numCtx ?? c.caps.contextTokens;
  if (!p.minCtx || numCtx === undefined) return term();
  if (numCtx >= p.minCtx) return term(1);
  return term(-3, [], [`context ${numCtx} < ${p.minCtx}`]);
}

function localityScore(c: Candidate): Term {
  return c.channelType === "ollama" ? term(1, ["local/free"]) : term();
}

function perfScore(c: Candidate, p: Profile, speedPriority: number): Term {
  const perf = c.caps.perf;
  const why: string[] = [];
  const warnings: string[] = [];
  let delta = 0;
  if (perf?.tokPerSec !== undefined) {
    const speedTerm = Math.min(Math.max(Math.log2(perf.tokPerSec / 20), -1.5), 2);
    delta += speedTerm * (p.latency === "interactive" ? SCORE_WEIGHTS.interactiveSpeed : SCORE_WEIGHTS.batchSpeed) * (speedPriority / 2);
    why.push(`${Math.round(perf.tokPerSec)} tok/s`);
  }
  if (p.needsEdit) {
    if (perf?.editOk === true) {
      delta += SCORE_WEIGHTS.edit;
      why.push("edit ok");
    } else {
      warnings.push("edit ability not measured");
    }
  }
  if (p.minToolReliability !== undefined) {
    if (perf?.toolReliability === undefined) {
      warnings.push("tool reliability not measured");
    } else {
      delta += SCORE_WEIGHTS.reliability * perf.toolReliability;
      why.push(`tool ${Math.round(perf.toolReliability * 3)}/3`);
    }
  }
  return term(delta, why, warnings);
}

function costScore(c: Candidate, p: Profile, costPriority: number): Term {
  if (!c.costTier) return term();
  const idx = { free: 0, low: 1, mid: 2, high: 3 }[c.costTier];
  const why = [c.costTier === "free" ? "free" : `${c.costTier} cost`];
  if (idx === 0) return term(0, why);
  const w = SCORE_WEIGHTS.costPerTier[p.costSensitivity ?? "medium"] * (costPriority / 2) * (p.parallelism === "high" ? SCORE_WEIGHTS.parallelismCost : 1);
  return term(-idx * w, why);
}

function hardwareWarnings(c: Candidate, size: number | undefined, sctx?: SetupContext): string[] {
  if (!sctx?.hardware || c.channelType !== "ollama" || size === undefined) return [];
  const need = size * 0.6;
  const budget = sctx.hardware.gpus?.reduce((m, g) => Math.max(m, g.vramGb), 0) || sctx.hardware.ramGb;
  if (need > budget) return [`~${size}B needs ~${Math.round(need)}GB at Q4; ~${Math.round(budget)}GB available`];
  return [];
}

function score(c: Candidate, p: Profile, sctx?: SetupContext): { score: number; why: string[]; warnings: string[] } {
  const priorities = sctx?.priorities ?? { speed: 2, cost: 2, quality: 2 };
  const q = priorities.quality / 2;
  const size = effectiveSize(c);
  const terms = [
    sizeScore(p, size, q),
    capabilityScore(c, p, q),
    contextScore(c, p),
    localityScore(c),
    perfScore(c, p, priorities.speed),
    costScore(c, p, priorities.cost),
  ];
  return {
    score: 10 + terms.reduce((a, t) => a + t.delta, 0),
    why: terms.flatMap((t) => t.why),
    warnings: [...terms.flatMap((t) => t.warnings), ...hardwareWarnings(c, size, sctx)],
  };
}

/**
 * Deterministic best-match of candidates to roles. Hard requirements filter; soft weights rank.
 * A role nobody can fill is reported in `unfilled` instead of getting a bad model.
 */
export function scoreAssignments(roleIds: string[], candidates: Candidate[], ctx?: SetupContext): { assignments: ScoredAssignment[]; unfilled: Unfilled[] } {
  const assignments: ScoredAssignment[] = [];
  const unfilled: Unfilled[] = [];
  const uses = new Map<string, number>();
  for (const role of roleIds) {
    const { best, reasons } = bestFor(ROLE_PROFILES[role] ?? DEFAULT_PROFILE, candidates, ctx, uses);
    if (!best) {
      unfilled.push({ role, reason: unfilledReason(candidates, reasons) });
      continue;
    }
    const key = `${best.c.channel}:${best.c.model}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
    assignments.push(toAssignment(role, best));
  }
  return { assignments, unfilled };
}

type Best = { c: Candidate; eff: number; raw: ReturnType<typeof score> };

/** Highest effective score among eligible candidates (ties keep the earlier one); `reasons` collects why the rest were refused. */
function bestFor(p: Profile, candidates: Candidate[], ctx: SetupContext | undefined, uses: Map<string, number>): { best: Best | undefined; reasons: Set<string> } {
  const reasons = new Set<string>();
  let best: Best | undefined;
  for (const c of candidates) {
    const why = eligible(c, p);
    if (why) {
      reasons.add(why);
      continue;
    }
    const raw = score(c, p, ctx);
    const key = `${c.channel}:${c.model}`;
    const eff = raw.score * (1 - 0.05 * (uses.get(key) ?? 0)); // spread across models when near-equal
    if (!best || eff > best.eff) best = { c, eff, raw };
  }
  return { best, reasons };
}

function unfilledReason(candidates: Candidate[], reasons: Set<string>): string {
  return candidates.length ? `no model with: ${[...reasons].map((r) => r.replace(/^no /, "")).join(", ")}` : "no models available";
}

function toAssignment(role: string, best: Best): ScoredAssignment {
  return {
    role,
    channel: best.c.channel,
    model: best.c.model,
    reason: best.raw.why.join(", ") || "best available",
    score: Math.round(best.raw.score * 10) / 10,
    warnings: best.raw.warnings,
    source: "rules",
  };
}

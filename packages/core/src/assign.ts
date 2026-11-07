import type { ModelCaps } from "./channels/types.js";
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
  if (p.needs?.tools && c.caps.tools === "none") return "no tool support";
  if (p.needs?.vision && c.caps.vision !== true) return "no vision";
  if (p.needs?.imageGen && c.caps.imageGen !== true) return "no image generation";
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

function score(c: Candidate, p: Profile, sctx?: SetupContext): { score: number; why: string[]; warnings: string[] } {
  const why: string[] = [];
  const warnings: string[] = [];
  const priorities = sctx?.priorities ?? { speed: 2, cost: 2, quality: 2 };
  const q = priorities.quality / 2;
  let s = 10;
  const size = effectiveSize(c);
  if (size !== undefined) {
    const sz = Math.min(Math.log2(Math.max(size, 1) / 2), 6);
    if (p.cheap) {
      s += 3 - Math.abs(sz - 2); // favour small-mid models
      why.push("fast/cheap");
    } else {
      s += sz * q;
    }
    if (p.minSizeB && size < p.minSizeB) {
      s -= 4;
      warnings.push(`model is ~${size}B; ${p.minSizeB}B+ recommended for this role`);
    }
  } else if (p.minSizeB) {
    warnings.push("model size unknown");
  }
  if (c.caps.tools === "native") {
    s += 2;
    why.push("native tools");
  }
  if (p.wantsReasoning && c.caps.reasoning) {
    s += 3 * q;
    why.push("reasoning");
  }
  if (p.wantsCoder && CODER.test(c.model)) {
    s += 2 * q;
    why.push("coding model");
  }
  if (p.needs?.vision && c.caps.vision) why.push("vision");
  if (p.needs?.imageGen && c.caps.imageGen) why.push("image generation");
  const numCtx = c.caps.numCtx ?? c.caps.contextTokens;
  if (p.minCtx && numCtx !== undefined) {
    if (numCtx >= p.minCtx) s += 1;
    else {
      s -= 3;
      warnings.push(`context ${numCtx} < ${p.minCtx}`);
    }
  }
  if (c.channelType === "ollama") {
    s += 1;
    why.push("local/free");
  }
  const perf = c.caps.perf;
  if (perf?.tokPerSec !== undefined) {
    const speedTerm = Math.min(Math.max(Math.log2(perf.tokPerSec / 20), -1.5), 2);
    s += speedTerm * (p.latency === "interactive" ? SCORE_WEIGHTS.interactiveSpeed : SCORE_WEIGHTS.batchSpeed) * (priorities.speed / 2);
    why.push(`${Math.round(perf.tokPerSec)} tok/s`);
  }
  if (p.needsEdit) {
    if (perf?.editOk === true) {
      s += SCORE_WEIGHTS.edit;
      why.push("edit ok");
    } else {
      warnings.push("edit ability not measured");
    }
  }
  if (p.minToolReliability !== undefined) {
    if (perf?.toolReliability === undefined) {
      warnings.push("tool reliability not measured");
    } else {
      s += SCORE_WEIGHTS.reliability * perf.toolReliability;
      why.push(`tool ${Math.round(perf.toolReliability * 3)}/3`);
    }
  }
  if (c.costTier) {
    const idx = { free: 0, low: 1, mid: 2, high: 3 }[c.costTier];
    if (idx > 0) {
      const w = SCORE_WEIGHTS.costPerTier[p.costSensitivity ?? "medium"] * (priorities.cost / 2) * (p.parallelism === "high" ? SCORE_WEIGHTS.parallelismCost : 1);
      s -= idx * w;
    }
    why.push(c.costTier === "free" ? "free" : `${c.costTier} cost`);
  }
  if (sctx?.hardware && c.channelType === "ollama" && size !== undefined) {
    const need = size * 0.6;
    const budget = sctx.hardware.gpus?.reduce((m, g) => Math.max(m, g.vramGb), 0) || sctx.hardware.ramGb;
    if (need > budget) warnings.push(`~${size}B needs ~${Math.round(need)}GB at Q4; ~${Math.round(budget)}GB available`);
  }
  return { score: s, why, warnings };
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
    const p = ROLE_PROFILES[role] ?? DEFAULT_PROFILE;
    const reasons = new Set<string>();
    let best: { c: Candidate; eff: number; raw: ReturnType<typeof score> } | undefined;
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
    if (!best) {
      unfilled.push({ role, reason: candidates.length ? `no model with: ${[...reasons].map((r) => r.replace(/^no /, "")).join(", ")}` : "no models available" });
      continue;
    }
    const key = `${best.c.channel}:${best.c.model}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
    assignments.push({
      role,
      channel: best.c.channel,
      model: best.c.model,
      reason: best.raw.why.join(", ") || "best available",
      score: Math.round(best.raw.score * 10) / 10,
      warnings: best.raw.warnings,
      source: "rules",
    });
  }
  return { assignments, unfilled };
}

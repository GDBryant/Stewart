import type { ModelCaps } from "./channels/types.js";

/** One selectable model with whatever capabilities are known. */
export interface Candidate {
  channel: string;
  channelType: string;
  model: string;
  caps: Partial<ModelCaps>;
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
}

export const ROLE_PROFILES: Record<string, Profile> = {
  orchestrator: { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true },
  planner: { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true },
  "plan-validator": { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true },
  investigator: { needs: { tools: true }, minCtx: 16384 },
  architect: { needs: { tools: true }, minCtx: 16384, minSizeB: 8, wantsReasoning: true },
  "general-worker": { needs: { tools: true }, minCtx: 16384, wantsCoder: true },
  "code-writer": { needs: { tools: true }, minCtx: 16384, minSizeB: 7, wantsCoder: true },
  "code-reviewer": { needs: { tools: true }, minCtx: 16384, wantsReasoning: true },
  tester: { needs: { tools: true }, minCtx: 16384, wantsCoder: true },
  "document-writer": { cheap: true },
  "image-reader": { needs: { vision: true } },
  "image-writer": { needs: { imageGen: true } },
};

const DEFAULT_PROFILE: Profile = { needs: { tools: true } };

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
  return undefined;
}

/** True when the candidate meets the role's hard requirements. */
export function meetsHardRequirements(role: string, c: Candidate): boolean {
  return eligible(c, ROLE_PROFILES[role] ?? DEFAULT_PROFILE) === undefined;
}

function score(c: Candidate, p: Profile): { score: number; why: string[]; warnings: string[] } {
  const why: string[] = [];
  const warnings: string[] = [];
  let s = 10;
  const size = effectiveSize(c);
  if (size !== undefined) {
    const sz = Math.min(Math.log2(Math.max(size, 1) / 2), 6);
    if (p.cheap) {
      s += 3 - Math.abs(sz - 2); // favour small-mid models
      why.push("fast/cheap");
    } else {
      s += sz;
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
    s += 3;
    why.push("reasoning");
  }
  if (p.wantsCoder && CODER.test(c.model)) {
    s += 2;
    why.push("coding model");
  }
  if (p.needs?.vision && c.caps.vision) why.push("vision");
  if (p.needs?.imageGen && c.caps.imageGen) why.push("image generation");
  const ctx = c.caps.numCtx ?? c.caps.contextTokens;
  if (p.minCtx && ctx !== undefined) {
    if (ctx >= p.minCtx) s += 1;
    else {
      s -= 3;
      warnings.push(`context ${ctx} < ${p.minCtx}`);
    }
  }
  if (c.channelType === "ollama") {
    s += 1;
    why.push("local/free");
  }
  return { score: s, why, warnings };
}

/**
 * Deterministic best-match of candidates to roles. Hard requirements filter; soft weights rank.
 * A role nobody can fill is reported in `unfilled` instead of getting a bad model.
 */
export function scoreAssignments(roleIds: string[], candidates: Candidate[]): { assignments: ScoredAssignment[]; unfilled: Unfilled[] } {
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
      const raw = score(c, p);
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

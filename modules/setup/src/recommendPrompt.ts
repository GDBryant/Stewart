import type { EffectiveConfig } from "@stewart/roles-skills";
import { ROLE_PROFILES, type Candidate, type scoreAssignments } from "./assign.js";
import type { SetupContext } from "./setupContext.js";
import { resolveModelProfile } from "@stewart/models";

const CAP_KEYS = ["tools", "vision", "reasoning", "imageGen", "contextTokens"] as const;

/** Structural copy of the discovered-channel shape used by recommend.ts. */
export interface PromptChannel {
  id: string;
  type: string;
  models: string[];
  error?: string;
}

export interface RecommendPromptInput {
  config: EffectiveConfig;
  channels: PromptChannel[];
  candidates: Candidate[];
  rules: ReturnType<typeof scoreAssignments>;
  context?: Partial<SetupContext>;
}

function roleLinesOf(config: EffectiveConfig): string {
  return config.roles
    .map((r) => {
      const t = ROLE_PROFILES[r.id]?.typicalTurns;
      return `- ${r.id}${t ? ` (~${t[0]}-${t[1]} turns)` : ""}: ${(r.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`;
    })
    .join("\n");
}

function modelLabel(config: EffectiveConfig, channelId: string, model: string, cd: Candidate | undefined): string {
  const caps = resolveModelProfile(config, { channel: channelId, model }).caps;
  const parts = CAP_KEYS.filter((k) => caps[k] !== undefined).map((k) => `${k}=${caps[k]}`);
  const perf = caps.perf;
  if (perf?.tokPerSec !== undefined) parts.push(`${Math.round(perf.tokPerSec)}tok/s`);
  if (perf?.toolReliability !== undefined) parts.push(`tool=${Math.round(perf.toolReliability * 3)}/3`);
  if (perf?.editOk !== undefined) parts.push(`edit=${perf.editOk}`);
  if (cd?.costBlended !== undefined) parts.push(`$${cd.costBlended.toFixed(2)}/MTok(${cd.costTier})`);
  return parts.length ? `${model} (${parts.join(", ")})` : model;
}

function channelLinesOf(config: EffectiveConfig, channels: PromptChannel[], candidates: Candidate[]): string {
  const cand = new Map(candidates.map((c) => [`${c.channel}:${c.model}`, c]));
  return channels
    .map((c) => {
      const models = c.models.map((m) => modelLabel(config, c.id, m, cand.get(`${c.id}:${m}`))).join("; ");
      return `- ${c.id} (${c.type})${c.error ? ` [listModels failed: ${c.error}]` : ""}: ${models}`;
    })
    .join("\n");
}

/** Builds the researcher prompt: roles, discovered models with capabilities, optional context, and the rules baseline. */
export function buildRecommendPrompt(input: RecommendPromptInput): string {
  const { config, channels, candidates, rules, context } = input;
  return [
    "You are assigning models to agent roles for a coding assistant.",
    "",
    "Roles:",
    roleLinesOf(config),
    "",
    "Available channels and discovered models (known capabilities in parentheses):",
    channelLinesOf(config, channels, candidates),
    formatContextBlock(context),
    "",
    'Return ONLY a JSON object {"assignments":[{"role":"roleId","channel":"channelId","model":"model","reason":"short"}]}.',
    "A deterministic scorer proposed this baseline (keep it unless you have a clear reason):",
    rules.assignments.map((a) => `- ${a.role}: ${a.channel}:${a.model}`).join("\n") || "(none)",
    "",
    "Choose the best model for each role. Every role must appear; channel and model must come from the candidates above.",
    "Prefer reasoning models for orchestrator, planner, plan-validator, code-reviewer and code-health-reviewer; vision-capable models for image-reader; imageGen for image-writer; strong tool-use coding models for code-writer, general-worker and tester; cheaper fast models are acceptable for document-writer.",
  ].join("\n");
}

function formatContextBlock(sc: Partial<SetupContext> | undefined): string {
  const ctxLines = [
    sc?.workspace ? `- workspace: ${sc.workspace.sizeClass} (${sc.workspace.files} files, ~${sc.workspace.loc} loc${sc.workspace.monorepo ? ", monorepo" : ""})` : "",
    sc?.hardware ? `- hardware: ${sc.hardware.os}, ${sc.hardware.ramGb}GB RAM${sc.hardware.gpus?.length ? `, GPU ${sc.hardware.gpus.map((g) => `${g.name} ${g.vramGb}GB`).join("/")}` : ""}` : "",
    sc?.priorities ? `- priorities (1-3): speed ${sc.priorities.speed}, cost ${sc.priorities.cost}, quality ${sc.priorities.quality}` : "",
    sc?.typicalWork ? `- typical work: ${sc.typicalWork}` : "",
  ].filter(Boolean);
  return ctxLines.length ? `\nContext:\n${ctxLines.join("\n")}\n` : "";
}

import type { AgentSummary, ChannelSummary, Effort } from "./bridge.js";
import type { State } from "./state.js";

/** Fallback choice for the loop-guard hand-over. `auto`/`off` omit `escalation` from settings so the engine's ranking is the sole behavior. */
export type FallbackMode = "off" | "auto" | "explicit";
export type FallbackPreference = { mode: FallbackMode; agentId?: string; effort?: Effort };

export const EFFORTS: Effort[] = ["low", "medium", "high", "max"];

export interface DivertCandidate {
  agentId: string;
  channel: string;
  model: string;
  reasoning: boolean | undefined;
  contextTokens?: number;
  /** Ranking for "Auto (best available)": reasoning-capable first, then wider verified context (mirrors `divertTarget` in @stewart/roles-skills). */
  score: number;
}

/**
 * Divert candidates for the deep-thinking step: agents on probed models, ranked strongest first
 * (reasoning-capable over unknown, then wider context). Unknown reasoning happens when the channel
 * never reports it (openai-compatible) — the UI marks those, the engine's `agentRefusal` makes the final call.
 */
export function divertCandidates(
  agents: AgentSummary[],
  channels: ChannelSummary[],
  probeResults: State["probeResults"],
): DivertCandidate[] {
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const byChannel = new Map(channels.map((c) => [c.id, c]));
  const out: DivertCandidate[] = [];
  for (const a of agents) {
    const probe = probeResults[`${a.channel}:${a.model}`];
    if (!probe || !probe.ok) continue;
    const caps = probe.caps ?? {};
    const reasoning = caps.reasoning === true;
    const modelCaps = byChannel.get(a.channel)?.modelCaps?.[a.model] as { contextTokens?: unknown } | undefined;
    const contextTokens = num(caps.contextTokens) ?? num(modelCaps?.contextTokens);
    out.push({ agentId: a.id, channel: a.channel, model: a.model, reasoning, contextTokens, score: (reasoning ? 1000000000 : 0) + (contextTokens ?? 0) });
  }
  return out.sort((x, y) => y.score - x.score || (x.agentId < y.agentId ? -1 : 1));
}

/** The `escalation` block the wizard writes to settings.yaml, or undefined for Off/Auto (engine ranking is the sole behavior). */
export function fallbackToEscalation(p: FallbackPreference): { onLoopGuard: { agent?: string; effort?: Effort } } | undefined {
  if (p.mode !== "explicit" || !p.agentId || p.agentId === "auto") return undefined;
  return { onLoopGuard: { agent: p.agentId, ...(p.effort ? { effort: p.effort } : {}) } };
}

/** Seed the step from current settings: an explicit `escalation.onLoopGuard.agent` restores the last choice. */
export function initialFallback(settings?: { escalation?: { onLoopGuard?: { agent?: string; effort?: Effort } } }): FallbackPreference {
  const onLoopGuard = settings?.escalation?.onLoopGuard;
  const agentId = onLoopGuard?.agent;
  return {
    mode: agentId ? "explicit" : "auto",
    ...(agentId ? { agentId } : {}),
    ...(agentId ? { effort: onLoopGuard?.effort ?? "high" } : {}),
  };
}

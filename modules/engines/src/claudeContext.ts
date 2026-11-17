import type { EngineEvent } from "./types.js";
import { num, obj, str, type Obj } from "./claudeLines.js";

export interface ClaudeObs {
  cliSessionId?: string;
  inputTokens?: number;
  windowTokens?: number;
  compacted: boolean;
  turnCount?: number;
  spawnError?: string;
}

export function inputTokensOf(u: Obj | undefined): number | undefined {
  const vals = [num(u?.input_tokens), num(u?.cache_creation_input_tokens), num(u?.cache_read_input_tokens)];
  return vals.some((v) => v !== undefined) ? vals.reduce<number>((n, v) => n + (v ?? 0), 0) : undefined;
}

export function windowTokensOf(j: Obj): number | undefined {
  const usage = obj(j.modelUsage);
  for (const raw of Object.values(usage ?? {})) {
    const window = num(obj(raw)?.contextWindow);
    if (window !== undefined) return window;
  }
  return undefined;
}

export function observeSystem(obs: ClaudeObs, j: Obj): void {
  obs.cliSessionId = str(j.session_id) ?? obs.cliSessionId;
  if (j.subtype === "compact_boundary" || str(j.compact_result) === "success") obs.compacted = true;
}

export function contextEvent(obs: ClaudeObs): EngineEvent {
  return {
    kind: "claude.context",
    cliSessionId: obs.cliSessionId,
    inputTokens: obs.inputTokens,
    windowTokens: obs.windowTokens,
    compacted: obs.compacted,
    turnCount: obs.turnCount,
  };
}

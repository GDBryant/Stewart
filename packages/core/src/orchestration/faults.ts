import type { ChatMessage } from "../channels/types.js";
import type { LoopResult } from "../tools/toolLoop.js";

/** Recoverable fault kinds (v1 port; see docs/FAULT_RECOVERY.md). */
export type FaultKind = "truncated" | "incomplete_stream" | "turn_limit";

/** Maps a finished loop result to a recoverable fault; completed and other failures give undefined. */
export function classifyFault(result: LoopResult): FaultKind | undefined {
  if (result.kind === "turn_limit") return "turn_limit";
  if (result.kind !== "failed") return undefined;
  if (result.code === "truncated") return "truncated";
  if (result.code === "incomplete_stream") return "incomplete_stream";
  return undefined;
}

/** Tools whose success counts as progress for the stuck check. */
const PROGRESS_TOOLS = new Set([
  "WriteFile",
  "EditFile",
  "ApplyPatch",
  "RunTerminal",
  "GenerateImage",
  "submit_plan",
  "submit_verdict",
  "submit_replacements",
  "submit_result",
]);

const ERR_PREFIX = /^(Error:|Rejected|Invalid tool call|Outcome uncertain|Not executed|Not answered)/;

export function successfulOutcome(content: string): boolean {
  return !ERR_PREFIX.test(content);
}

/**
 * A worker counts as stuck when the same tool name with identical arguments
 * appears 3+ times, or the last 5 tool-call turns contain no successful
 * edit/write/terminal call. Never blocks a decision; only sets the
 * recommended option.
 */
export function detectStuck(messages: ChatMessage[]): { stuck: boolean; reason?: string } {
  const seen = new Map<string, number>();
  const outcomes = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) outcomes.set(m.toolCallId, m.content);
  }
  const turns: { name: string; progress: boolean }[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    let progress = false;
    for (const c of m.toolCalls) {
      const key = `${c.name}\n${JSON.stringify(c.arguments)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n >= 3) return { stuck: true, reason: `same call repeated ${n}x: ${c.name}` };
      if (PROGRESS_TOOLS.has(c.name)) {
        const out = outcomes.get(c.id);
        if (out !== undefined && successfulOutcome(out)) progress = true;
      }
    }
    turns.push({ name: m.toolCalls[0].name, progress });
  }
  const last = turns.slice(-5);
  if (last.length >= 5 && !last.some((t) => t.progress)) {
    return { stuck: true, reason: "no successful edit, write or terminal call in the last 5 turns" };
  }
  return { stuck: false };
}

/** Successful tool calls as `name path|command`, most recent last, capped. */
export function actionsSoFar(messages: ChatMessage[], cap: number): string[] {
  const outcomes = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) outcomes.set(m.toolCallId, m.content);
  }
  const acts: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      const out = outcomes.get(c.id);
      if (out === undefined || !successfulOutcome(out)) continue;
      const target = c.arguments.path ?? c.arguments.command ?? c.arguments.task ?? "";
      acts.push(`${c.name}${typeof target === "string" && target ? ` ${target.slice(0, 120)}` : ""}`);
    }
  }
  return acts.slice(-cap);
}

/** Tool calls in a transcript; used as the idempotency index offset for continuations. */
export function countToolCalls(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === "assistant" && m.toolCalls) n += m.toolCalls.length;
  return n;
}

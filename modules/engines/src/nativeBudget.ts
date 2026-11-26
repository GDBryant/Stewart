import type { EngineTurn } from "./types.js";

/** Budget nudge this many turns before the end. */
const NUDGE_LEFT = 3;
/** Budgets below this (bench probes, conformance) get no nudge and no report-only last turn. */
const BUDGET_MIN = 10;
const EMPTY_REPORT = "(No report: the last turn only requested tools, which were ignored.)";

/**
 * Budget notes for model turn `n`: warns NUDGE_LEFT turns before the end, and makes the last turn
 * report-only. Tools stay in the request so the history renders unchanged; calls made on it are dropped.
 * Returns true for that last turn.
 */
export function budgetTurn(turn: EngineTurn, n: number): boolean {
  if (turn.maxTurns < BUDGET_MIN) return false;
  const left = turn.maxTurns - n;
  if (left === NUDGE_LEFT) {
    turn.transcript.push({ role: "user", content: `[Stewart] ${left} model turns left; the last is for your report only. Stop investigating: make the change and verify it now.` });
  }
  if (left !== 1) return false;
  turn.transcript.push({ role: "user", content: "[Stewart] Turn budget used up; this is your last reply. Do not call tools: any call is ignored. Report what you found, what you changed, and the exact remaining change (file, code) so the task can continue." });
  return true;
}

/** The report-only reply must not leave dangling tool calls, nor an empty assistant message. */
export function dropCalls(turn: EngineTurn): void {
  const msg = turn.transcript[turn.transcript.length - 1];
  if (msg?.role !== "assistant" || !msg.toolCalls) return;
  delete msg.toolCalls;
  if (!msg.content.trim()) msg.content = EMPTY_REPORT;
}

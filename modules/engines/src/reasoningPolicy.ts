import type { ToolCall } from "@stewart/kernel";
import type { EngineTurn } from "./types.js";

/** Tools whose outcome needs no planning: the next turn can run with reasoning off. */
const ROUTINE_TOOLS = new Set(["ReadFile", "Search", "FindFiles", "ListCodeFiles", "health_batches", "ReadImage", "GetDiff"]);
/** Reasoning chars with no content or tool call after which a request is cut and retried with thinking off. */
export const OVERRUN_CHARS = 20_000;

export interface FinishedCall {
  call: ToolCall;
  ok: boolean;
}

/**
 * Per-run reasoning control for channels that route a reasoning field (`ManagedChannel.reasoningRouting`).
 * Full effort on the first turn, after any failed or non-routine call, after a loop-guard warning and for the
 * final report; `think:false` after successful read/search/list outcomes. An explicit role `think` is authoritative.
 */
export class ReasoningPolicy {
  private routine = false;
  private overruns = 0;

  /** Record one model turn's finished tool calls; `warned` = the loop guard added a nudge. */
  observe(calls: FinishedCall[], warned: boolean): void {
    this.routine = !warned && calls.length > 0 && calls.every((c) => c.ok && ROUTINE_TOOLS.has(c.call.name));
  }

  private active(turn: EngineTurn): boolean {
    return turn.think === undefined && turn.channel.reasoningRouting(turn.agent.model);
  }

  /** True when this request should ask for thinking off. */
  thinkOff(turn: EngineTurn, report: boolean): boolean {
    return this.routine && !report && this.active(turn);
  }

  /** True while the reasoning-overrun guard may cut a request (once per run). */
  watch(turn: EngineTurn): boolean {
    return this.overruns === 0 && this.active(turn);
  }

  /** Consumes the run's single overrun retry. */
  overran(): void {
    this.overruns++;
  }
}

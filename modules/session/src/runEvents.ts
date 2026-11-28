import type { RunEvent } from "@stewart/protocol";
import { runOutcome, type RunState } from "./turnState.js";
import type { TaskResult } from "./taskRun.js";

function contextAtFailure(rs: RunState): string | undefined {
  const c = rs.engineContext;
  return c?.inputTokens === undefined ? undefined : `${c.inputTokens}/${c.windowTokens ?? "unknown"}`;
}

export type RunEventTarget = { runId: string; roleId: string; rs: RunState };

export function failedRunEvent(t: RunEventTarget, error: string, outcome?: ReturnType<typeof runOutcome>): RunEvent {
  const { runId, roleId, rs } = t;
  const context = contextAtFailure(rs);
  return {
    kind: "run.finished",
    runId,
    roleId,
    status: "failed",
    error,
    ...(context ? { contextAtFailure: context } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** The terminal run.finished event: cancel and cost cap short-circuit without an outcome. */
export function finishedEvent(t: RunEventTarget, res: TaskResult, outcome: ReturnType<typeof runOutcome>): RunEvent {
  const { runId, roleId, rs } = t;
  if (rs.costCapped) return failedRunEvent(t, "cost cap reached");
  if (res.reason === "cancelled") return { kind: "run.finished", runId, roleId, status: "cancelled" };
  if (res.status === "done") return { kind: "run.finished", runId, roleId, status: "done", outcome };
  return failedRunEvent(t, res.error ?? "failed", outcome);
}

import type { RunEvent } from "@stewart/protocol";
import { runOutcome, type RunState } from "./turnState.js";
import type { TaskResult } from "./taskRun.js";

function contextAtFailure(rs: RunState): string | undefined {
  const c = rs.engineContext;
  return c?.inputTokens === undefined ? undefined : `${c.inputTokens}/${c.windowTokens ?? "unknown"}`;
}

export function failedRunEvent(runId: string, rs: RunState, error: string, outcome?: ReturnType<typeof runOutcome>): RunEvent {
  const context = contextAtFailure(rs);
  return {
    kind: "run.finished",
    runId,
    roleId: "lead",
    status: "failed",
    error,
    ...(context ? { contextAtFailure: context } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** The terminal run.finished event: cancel and cost cap short-circuit without an outcome. */
export function finishedEvent(runId: string, rs: RunState, res: TaskResult, outcome: ReturnType<typeof runOutcome>): RunEvent {
  if (rs.costCapped) return failedRunEvent(runId, rs, "cost cap reached");
  if (res.reason === "cancelled") return { kind: "run.finished", runId, roleId: "lead", status: "cancelled" };
  if (res.status === "done") return { kind: "run.finished", runId, roleId: "lead", status: "done", outcome };
  return failedRunEvent(runId, rs, res.error ?? "failed", outcome);
}

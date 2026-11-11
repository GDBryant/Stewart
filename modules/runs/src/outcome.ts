import type { RunRuntime, TaskResult } from "@stewart/run-contract";
import { timeCapMessage } from "./consts.js";
import type { RunOutcome } from "./strategy.js";
import type { Run } from "./types.js";

/** Maps a direct run's final task result to its run outcome (cancel, time cap, failure, stop, or done). */
export function outcomeOf(run: Run, rt: RunRuntime, res: TaskResult): RunOutcome {
  if (res.status === "cancelled" || run.status === "cancelled") {
    return rt.timeCap?.hit
      ? { status: "interrupted", event: "stopped", error: timeCapMessage(rt.timeCap.ms) }
      : { status: "cancelled", event: "cancelled" };
  }
  if (res.status === "failed") return { status: "failed", event: "failed", error: res.summary };
  if (res.status === "stopped" || res.status === "parked") return { status: "interrupted", event: "stopped", error: res.summary };
  return { status: "done", event: "done" };
}

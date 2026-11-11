import type { RoleDef } from "@stewart/config";
import type { TaskRecord } from "@stewart/scheduling";
import type { RunRuntime, TaskResult } from "@stewart/run-contract";

export function taskRecordStatus(result: TaskResult): TaskRecord["status"] {
  return result.status === "done" ? "done" : result.status === "failed" ? "failed" : result.status === "parked" ? "parked" : "stopped";
}

export function taskOutcomeEvent(rt: RunRuntime, rec: TaskRecord, role: RoleDef, result: TaskResult): Parameters<RunRuntime["bus"]["emit"]>[0] {
  return result.status === "done"
    ? { kind: "task.done", runId: rt.runId, taskId: rec.id, roleId: role.id, summary: result.summary.slice(0, 400) }
    : { kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: result.summary.slice(0, 400) };
}

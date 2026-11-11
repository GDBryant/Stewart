import type { RoleDef } from "@stewart/config";
import type { ToolCall } from "@stewart/kernel";
import { type RunRuntime } from "@stewart/run-contract";
import type { ToolPreview } from "@stewart/permissions";

export function taskScratchDir(runId: string, taskId: string): string {
  return `.stewart/scratch/${runId}/task-${taskId.replace(/[^\w.-]/g, "_")}`;
}

function insideDir(dir: string, p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
  return norm === d || norm.startsWith(`${d}/`);
}

/** Auto-approves writes strictly inside the task's scratch dir; everything else delegates. */
export function scratchGate(
  taskDir: string,
  approve: RunRuntime["approve"],
): NonNullable<RunRuntime["approve"]> {
  return async (call: ToolCall, preview: ToolPreview | null, meta) => {
    if (preview?.kind === "file" && insideDir(taskDir, preview.path)) return { kind: "approved" };
    return approve(call, preview, meta);
  };
}

/** Role clone whose writePaths also cover the task scratch dir (empty list stays unrestricted). */
export function roleWithScratch(role: RoleDef, taskDir: string): RoleDef {
  if (role.writePaths.length === 0) return role;
  return { ...role, writePaths: [...role.writePaths, `${taskDir}/**`] };
}

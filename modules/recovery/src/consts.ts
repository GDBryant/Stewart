import { recoveryState, type RunRuntime, type RecoveryState } from "@stewart/run-contract";

export const SIZE_HINT =
  "Your previous reply hit the output limit. Submit at most half as much work, keep each description under 300 chars, and put large data in files.";
export const SIZE_RULE =
  "Keep milestones and tasks small. No single reply or file write should exceed ~150 lines; split larger output across files.";

/** Recovery decisions go to the host log, prefixed like the v1 `recovery` category. */
export function logRecovery(rt: RunRuntime, line: string): void {
  rt.host.log(`[run ${rt.runId}] ${line}`);
}

/** Lazily attach the per-run recovery state so hand-built runtimes get defaults. */
export function ensureRecovery(rt: RunRuntime): RecoveryState {
  return (rt.recovery ??= recoveryState(rt.config.settings));
}

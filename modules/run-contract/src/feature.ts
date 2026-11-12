import type { HostPort } from "@stewart/kernel";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { Tool } from "@stewart/tools";

/** The slice of the run runtime a feature may read (kept narrow so this file never imports `runtime.ts`). */
export interface FeatureRuntime {
  runId: string;
  host: Pick<HostPort, "files">;
  config: EffectiveConfig;
}

/** Read-only view of the running orchestration that a feature's tools may consult. */
export interface RunView {
  tasks(): { id: string; roleId: string; title: string; status?: string }[];
  /** Largest tool result the orchestrator accepts, in characters. */
  maxOutputChars: number;
}

/** One feature's per-run state and the tools that close over it. */
export interface FeatureRun {
  /** Tools offered to the Orchestrator (still filtered by its role tool list). */
  orchestratorTools(): Tool[];
  /** Tools offered to a dispatched task `taskId` (still filtered by that role's tool list). */
  taskTools(taskId: string): Tool[];
}

/** A product feature plugged into orchestrated runs without orchestration knowing it exists. */
export interface RunFeature {
  id: string;
  /** Tool names that end a role's turn. */
  terminalTools?: readonly string[];
  /** Tool names the Orchestrator holds when its role lists no tools. */
  orchestratorDefaultTools?: readonly string[];
  /** Tools unioned into shipped roles' non-empty tool lists at config load, keyed by role id. */
  requiredRoleTools?: Readonly<Record<string, readonly string[]>>;
  /** Refuse a run before planning; returns the error message, or undefined to proceed. */
  preflight?(userText: string, rt: FeatureRuntime): string | undefined;
  /** Per-run state; created once per orchestrated run. */
  createRun(rt: FeatureRuntime, view: RunView): FeatureRun;
}

export function terminalToolNames(features: readonly RunFeature[] | undefined): string[] {
  return (features ?? []).flatMap((f) => f.terminalTools ?? []);
}

export function orchestratorDefaultToolNames(features: readonly RunFeature[] | undefined): string[] {
  return (features ?? []).flatMap((f) => f.orchestratorDefaultTools ?? []);
}

/** Per-role union of every feature's required tools. */
export function requiredRoleTools(features: readonly RunFeature[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of features ?? []) {
    for (const [role, tools] of Object.entries(f.requiredRoleTools ?? {})) out[role] = [...new Set([...(out[role] ?? []), ...tools])];
  }
  return out;
}

/** First preflight refusal among the features, if any. */
export function runPreflight(features: readonly RunFeature[] | undefined, userText: string, rt: FeatureRuntime): string | undefined {
  for (const f of features ?? []) {
    const error = f.preflight?.(userText, rt);
    if (error) return error;
  }
  return undefined;
}

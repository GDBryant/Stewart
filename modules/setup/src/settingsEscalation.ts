import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface EscalationPatch {
  onLoopGuard: { enabled?: boolean; agent?: string; effort?: string };
}

/**
 * Merge a wizard `escalation` choice into the on-disk `settings.yaml` and stage the full file into the
 * draft's file set, so the save path backs it up, validates it (via `validateFiles`) and rolls it back
 * on failure — exactly like channels.yaml / agents.yaml / roles.yaml.
 * `onLoopGuard` replaces the saved block wholesale: `{}` (Auto) clears a previous pin/effort/off,
 * `{enabled:false}` is Off, `{agent, effort}` pins. Absent `escalation` is a no-op.
 */
export function mergeEscalationIntoSettings(
  baseSettings: string | undefined,
  escalation: EscalationPatch | undefined,
  currentFiles: Record<string, string>,
): Record<string, string> {
  if (!escalation) return currentFiles;
  const doc = (parseYaml(baseSettings?.trim() ? baseSettings : "version: 1\n") ?? {}) as Record<string, unknown>;
  const { onLoopGuard, ...other } = escalation;
  const saved = (doc.escalation as { onLoopGuard?: unknown } | undefined)?.onLoopGuard;
  if (!Object.keys(onLoopGuard).length && saved === undefined && !Object.keys(other).length) return currentFiles;
  const next: Record<string, unknown> = { ...(doc.escalation as object | undefined), ...other };
  if (Object.keys(onLoopGuard).length) next.onLoopGuard = onLoopGuard;
  else delete next.onLoopGuard;
  if (Object.keys(next).length) doc.escalation = next;
  else delete doc.escalation;
  return { ...currentFiles, "settings.yaml": stringifyYaml(doc) };
}

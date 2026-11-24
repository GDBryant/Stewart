import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Merge a wizard `escalation` choice into the on-disk `settings.yaml` and stage the full file into the
 * draft's file set, so the save path backs it up, validates it (via `validateFiles`) and rolls it back
 * on failure — exactly like channels.yaml / agents.yaml / roles.yaml.
 * Absent `escalation` is a no-op: the engine's auto-ranking stays the sole behavior (also how "Off" is expressed).
 */
export function mergeEscalationIntoSettings(
  baseSettings: string | undefined,
  escalation: { onLoopGuard: { agent?: string; effort?: string } } | undefined,
  currentFiles: Record<string, string>,
): Record<string, string> {
  if (!escalation) return currentFiles;
  const doc = (parseYaml(baseSettings?.trim() ? baseSettings : "version: 1\n") ?? {}) as Record<string, unknown>;
  doc.escalation = { ...(doc.escalation as object | undefined), ...escalation };
  return { ...currentFiles, "settings.yaml": stringifyYaml(doc) };
}

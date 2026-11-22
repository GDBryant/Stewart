import type { WriteRecord } from "@stewart/engines";
import type { ProjectPaths } from "@stewart/tools";

/** The tracker only sees the workspace-root repo; a successful tool write inside a nested repo still counts. */
export function mergeWrites(diff: string[] | undefined, writes: WriteRecord[], paths: ProjectPaths): string[] | undefined {
  if (diff === undefined) return undefined;
  const last = new Map<string, WriteRecord>();
  for (const w of writes) last.set(w.path, w);
  const out = [...diff];
  for (const w of last.values()) {
    if (!w.ok || out.includes(w.path)) continue;
    try {
      const p = paths.resolve(w.path);
      if (!out.includes(p)) out.push(p);
    } catch {
      // outside the project: not a reportable change
    }
  }
  return out;
}

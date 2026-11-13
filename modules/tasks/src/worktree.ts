import type { HostPort } from "@stewart/kernel";

type Host = Pick<HostPort, "proc">;

/** Dirty files (vs HEAD) mapped to their content hash; undefined when not a git repo or too many to hash. */
export type WorktreeState = Map<string, string> | undefined;

const MAX_DIRTY = 2000;
/** Stewart's and the Claude CLI's own state, and installed deps: never "the turn's edit". */
const IGNORED = /^(\.stewart|\.claude|node_modules)\//;

async function git(host: Host, cwd: string, argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const h = host.proc.run(["git", ...argv], { cwd, onData: (d) => (out += d) });
  const { code } = await h.done;
  return { code, out };
}

interface Dirty {
  path: string;
  deleted: boolean;
}

/** Entries from `git status --porcelain -z` (renames report the new path). */
function porcelain(out: string): Dirty[] {
  const parts = out.split("\0").filter(Boolean);
  const entries: Dirty[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    entries.push({ path: entry.slice(3), deleted: entry[0] === "D" || entry[1] === "D" });
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return entries;
}

/**
 * Snapshot of the worktree's dirty files (minus `.stewart/`, `.claude/`, `node_modules/`): path → blob hash (or "deleted").
 * Files not listed are clean (equal to HEAD), so two snapshots tell which files a turn changed by any means,
 * shell commands included.
 */
export async function worktreeState(host: Host, cwd: string): Promise<WorktreeState> {
  try {
    const st = await git(host, cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (st.code !== 0) return undefined;
    const dirty = porcelain(st.out).filter((d) => !IGNORED.test(d.path));
    if (dirty.length > MAX_DIRTY) return undefined;
    const out = new Map<string, string>();
    for (const d of dirty) if (d.deleted) out.set(d.path, "deleted");
    const present = dirty.filter((d) => !d.deleted).map((d) => d.path);
    if (!present.length) return out;
    const hashes = await git(host, cwd, ["hash-object", "--", ...present]);
    const lines = hashes.out.split("\n").filter(Boolean);
    if (hashes.code !== 0 || lines.length !== present.length) return undefined;
    present.forEach((p, i) => out.set(p, lines[i]));
    return out;
  } catch {
    return undefined;
  }
}

/** Files whose dirty state or content differs between two snapshots; undefined when either is unknown. */
export function worktreeChanges(before: WorktreeState, after: WorktreeState): string[] | undefined {
  if (!before || !after) return undefined;
  const out = new Set<string>();
  for (const [p, h] of after) if (before.get(p) !== h) out.add(p);
  for (const p of before.keys()) if (!after.has(p)) out.add(p);
  return [...out].sort();
}

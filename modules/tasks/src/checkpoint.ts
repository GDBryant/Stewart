import type { HostPort } from "@stewart/kernel";

type Host = Pick<HostPort, "files" | "proc">;

export interface CpPaths {
  cwd: string;
  stateDir: string;
  sessionId: string;
}

interface SnapManifest {
  files: Record<string, string | null>;
}

async function git(host: Host, cwd: string, argv: string[], env?: Record<string, string>): Promise<{ code: number; out: string }> {
  let out = "";
  const h = host.proc.run(["git", ...argv], { cwd, env, onData: (d) => (out += d) });
  const { code } = await h.done;
  return { code, out };
}

async function must(host: Host, cwd: string, argv: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(host, cwd, argv, env);
  if (r.code !== 0) throw new Error(`git ${argv[0]} failed (${r.code}): ${r.out.trim().slice(-300)}`);
  return r.out;
}

async function isGitRepo(host: Host, cwd: string): Promise<boolean> {
  const r = await git(host, cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.out.trim() === "true";
}

/** Lines of command output, minus empties. */
function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

async function gitCheckpoint(host: Host, p: CpPaths, label: string): Promise<string> {
  const indexFile = `${p.stateDir}/checkpoints/${p.sessionId}.index`;
  await host.files.writeAtomic(indexFile, "");
  const env = { GIT_INDEX_FILE: indexFile };
  const head = await must(host, p.cwd, ["rev-parse", "HEAD"], env).catch(() => "");
  await must(host, p.cwd, ["read-tree", head.trim() || "--empty"], env);
  await must(host, p.cwd, ["add", "-A"], env);
  const tree = (await must(host, p.cwd, ["write-tree"], env)).trim();
  const ref = `refs/stewart/${p.sessionId}`;
  const parent = await git(host, p.cwd, ["rev-parse", "--verify", ref]);
  const base = parent.code === 0 ? parent.out.trim() : head.trim();
  const commitArgs = base ? ["commit-tree", tree, "-p", base, "-m", `stewart checkpoint ${p.sessionId} ${label}`] : ["commit-tree", tree, "-m", `stewart checkpoint ${p.sessionId} ${label}`];
  const commit = (await must(host, p.cwd, commitArgs, env)).trim();
  await must(host, p.cwd, ["update-ref", ref, commit], env);
  await host.files.delete(indexFile).catch(() => {});
  return commit;
}

function snapDir(p: CpPaths): string {
  return `${p.stateDir}/checkpoints/${p.sessionId}`;
}

/** Existing snapshot manifests, oldest first. */
async function manifests(host: Host, p: CpPaths): Promise<{ id: string; path: string; m: SnapManifest }[]> {
  const dir = snapDir(p);
  if (!(await host.files.exists(dir))) return [];
  const ids = (await host.files.list(dir))
    .map((f) => f.split("/").pop() ?? f)
    .filter((f) => /^snap-\d+\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const out = [];
  for (const id of ids) {
    const path = `${dir}/${id}.json`;
    out.push({ id, path, m: JSON.parse((await host.files.read(path)).content) as SnapManifest });
  }
  return out;
}

/**
 * Snapshot checkpoint: current content of every file the session has touched (the union of earlier manifests
 * plus `files`). Files first touched later are added to this manifest by `recordOriginal`.
 */
async function snapCheckpoint(host: Host, p: CpPaths, files: string[]): Promise<string> {
  const prev = await manifests(host, p);
  const all = new Set([...prev.flatMap((x) => Object.keys(x.m.files)), ...files]);
  const manifest: SnapManifest = { files: {} };
  for (const f of all) manifest.files[f] = (await host.files.exists(f)) ? (await host.files.read(f)).content : null;
  const id = `snap-${prev.length + 1}`;
  await host.files.writeAtomic(`${snapDir(p)}/${id}.json`, JSON.stringify(manifest));
  return id;
}

/**
 * Copy-on-write for snapshot checkpoints: before the first write to a file no checkpoint has seen, record its
 * pre-write content (null = absent) in every existing manifest, so reverting to any of them restores or
 * deletes it. No-op for git checkpoints (no manifests) and for files already recorded.
 */
export async function recordOriginal(host: Host, p: CpPaths, path: string, content: string | null): Promise<void> {
  for (const x of await manifests(host, p)) {
    if (path in x.m.files) continue;
    x.m.files[path] = content;
    await host.files.writeAtomic(x.path, JSON.stringify(x.m));
  }
}

/** Take a worktree checkpoint without touching HEAD, branches or the user's index. */
export async function createCheckpoint(host: Host, p: CpPaths, label: string, files: string[]): Promise<string> {
  if (await isGitRepo(host, p.cwd)) return gitCheckpoint(host, p, label);
  return snapCheckpoint(host, p, [...new Set(files)]);
}

async function gitRevert(host: Host, p: CpPaths, id: string): Promise<{ restored: string[]; deleted: string[] }> {
  const treeFiles = new Set(lines(await must(host, p.cwd, ["ls-tree", "-r", "--name-only", id])));
  // `.stewart/` (plan file, reports) is Stewart's own state: the session resets plan status itself.
  const changed = lines(await must(host, p.cwd, ["diff", "--name-only", id, "--", "."])).filter((f) => treeFiles.has(f) && !f.startsWith(".stewart/"));
  if (changed.length) await must(host, p.cwd, ["restore", `--source=${id}`, "--worktree", "--", ...changed]);
  const untracked = lines(await must(host, p.cwd, ["ls-files", "--others", "--exclude-standard"]));
  const deleted: string[] = [];
  for (const f of untracked) {
    if (f.startsWith(".git/") || f.startsWith(".stewart/") || treeFiles.has(f)) continue;
    await host.files.delete(f);
    deleted.push(f);
  }
  return { restored: changed, deleted };
}

async function snapRevert(host: Host, p: CpPaths, id: string): Promise<{ restored: string[]; deleted: string[] }> {
  const manifest = JSON.parse((await host.files.read(`${snapDir(p)}/${id}.json`)).content) as SnapManifest;
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [f, content] of Object.entries(manifest.files)) {
    if (content === null) {
      if (await host.files.exists(f)) {
        await host.files.delete(f);
        deleted.push(f);
      }
    } else {
      await host.files.writeAtomic(f, content);
      restored.push(f);
    }
  }
  return { restored, deleted };
}

/** Restore the worktree to a checkpoint. Returns restored and deleted paths. */
export async function revert(host: Host, p: CpPaths, id: string): Promise<{ restored: string[]; deleted: string[] }> {
  if (await isGitRepo(host, p.cwd)) return gitRevert(host, p, id);
  return snapRevert(host, p, id);
}

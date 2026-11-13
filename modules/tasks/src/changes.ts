import { createHash } from "node:crypto";
import path from "node:path";
import type { HostPort } from "@stewart/kernel";

type Host = Pick<HostPort, "files" | "proc">;

export interface CpPaths {
  cwd: string;
  stateDir: string;
  sessionId: string;
}

/** One recorded state of the worktree: a git checkpoint commit or a content manifest. */
export interface Baseline {
  id: string;
  kind: "git" | "manifest" | "unavailable";
  reason?: string;
}

/** The one owner of "what changed on disk": checks, run outcome, checkpoints and revert all go through it. */
export interface ChangeTracker {
  begin(label: string): Promise<Baseline>;
  /** Re-derive a stored baseline id (kind comes from whether the project is git). */
  baseline(id: string): Promise<Baseline>;
  /** Project-relative paths that differ from the baseline (added, modified, deleted); undefined when unavailable. */
  diff(b: Baseline): Promise<string[] | undefined>;
  restore(b: Baseline): Promise<{ restored: string[]; deleted: string[] }>;
  /** Remove all tracker state for the session: checkpoint dir, temp index, and the git ref. Best-effort. */
  dispose(): Promise<void>;
}

const UNAVAILABLE = (reason: string): Baseline => ({ id: "", kind: "unavailable", reason });

/** Never the turn's edit, and excluded from manifest scan, diff and restore. */
const IGNORED = /^(\.git|\.stewart|\.claude|node_modules)\//;
/** Manifest scan only: build outputs and vendored envs are not the project's source. */
const SKIP = /^(\.git|\.stewart|\.claude|node_modules|dist|build|out|target|\.venv|venv|__pycache__|\.idea|\.gradle|\.next)\//;

const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
/** Both hosts cap `files.list` at 20000 entries; exactly the cap reads as truncated. */
const LIST_CAP = 20_000;

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

function lines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** NUL-separated git listings: space and non-ASCII paths stay intact. */
function nulLines(out: string): string[] {
  return out.split("\0").filter((l) => l.length > 0);
}

function sha256(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

interface Ctx {
  host: Host;
  p: CpPaths;
  indexFile: string;
  indexEnv: Record<string, string>;
  ignored: (f: string) => boolean;
  dir: string;
  blobs: string;
  isGit: () => Promise<boolean>;
}

async function ensureIndex(c: Ctx): Promise<void> {
  if (await c.host.files.exists(c.indexFile)) return;
  await c.host.files.writeAtomic(c.indexFile, "");
  const head = await git(c.host, c.p.cwd, ["rev-parse", "HEAD"], c.indexEnv);
  await must(c.host, c.p.cwd, ["read-tree", head.code === 0 ? head.out.trim() : "--empty"], c.indexEnv);
}

/** Run an op on the temp index; on failure drop it and retry once from a fresh read-tree. */
async function withIndex<T>(c: Ctx, fn: () => Promise<T>): Promise<T> {
  await ensureIndex(c);
  try {
    return await fn();
  } catch (e) {
    await c.host.files.delete(c.indexFile).catch(() => {});
    await ensureIndex(c);
    return await fn();
  }
}

async function gitBegin(c: Ctx, label: string): Promise<Baseline> {
  return await withIndex(c, async () => {
    await must(c.host, c.p.cwd, ["add", "-A"], c.indexEnv);
    const tree = (await must(c.host, c.p.cwd, ["write-tree"], c.indexEnv)).trim();
    const ref = `refs/stewart/${c.p.sessionId}`;
    const parent = await git(c.host, c.p.cwd, ["rev-parse", "--verify", ref]);
    const base = parent.code === 0 ? parent.out.trim() : (await git(c.host, c.p.cwd, ["rev-parse", "HEAD"])).out.trim();
    const args = base ? ["commit-tree", tree, "-p", base, "-m", `stewart checkpoint ${c.p.sessionId} ${label}`] : ["commit-tree", tree, "-m", `stewart checkpoint ${c.p.sessionId} ${label}`];
    const commit = (await must(c.host, c.p.cwd, args, c.indexEnv)).trim();
    await must(c.host, c.p.cwd, ["update-ref", ref, commit], c.indexEnv);
    return { id: commit, kind: "git" as const };
  });
}

async function gitDiff(c: Ctx, id: string): Promise<string[]> {
  const tree = await withIndex(c, async () => {
    await must(c.host, c.p.cwd, ["add", "-A"], c.indexEnv);
    return (await must(c.host, c.p.cwd, ["write-tree"], c.indexEnv)).trim();
  });
  const out = nulLines(await must(c.host, c.p.cwd, ["diff", "--name-only", "-z", id, tree]));
  return out.filter((f) => !c.ignored(f)).sort();
}

async function gitRestore(c: Ctx, id: string): Promise<{ restored: string[]; deleted: string[] }> {
  const treeFiles = new Set(nulLines(await must(c.host, c.p.cwd, ["ls-tree", "-r", "--name-only", "-z", id])));
  const changed = nulLines(await must(c.host, c.p.cwd, ["diff", "--name-only", "-z", id, "--", "."])).filter((f) => treeFiles.has(f) && !c.ignored(f));
  if (changed.length) await must(c.host, c.p.cwd, ["restore", `--source=${id}`, "--worktree", "--", ...changed]);
  const untracked = nulLines(await must(c.host, c.p.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const deleted: string[] = [];
  for (const f of untracked) {
    if (c.ignored(f) || treeFiles.has(f)) continue;
    await c.host.files.delete(f);
    deleted.push(f);
  }
  return { restored: changed, deleted };
}

// ---- manifest tracker -----------------------------------------------------

const manifestPath = (c: Ctx, id: string) => `${c.dir}/${id}.json`;

async function scan(c: Ctx): Promise<Record<string, string> | Baseline> {
  const raw = await c.host.files.list(".");
  if (raw.length >= LIST_CAP) return UNAVAILABLE(`file listing capped at ${LIST_CAP}`);
  const names = raw.filter((f) => !SKIP.test(f) && !c.ignored(f));
  if (names.length > MAX_FILES) return UNAVAILABLE(`more than ${MAX_FILES} files`);
  let bytes = 0;
  for (const f of names) bytes += (await c.host.files.stat(f)).size;
  if (bytes > MAX_BYTES) return UNAVAILABLE(`more than ${MAX_BYTES} bytes of files`);
  const out: Record<string, string> = {};
  for (const f of names) out[f] = sha256((await c.host.files.readBinary(f)).base64);
  return out;
}

async function manBegin(c: Ctx): Promise<Baseline> {
  const m = await scan(c);
  if ("kind" in m) return m as Baseline;
  for (const [f, sha] of Object.entries(m)) {
    const blob = `${c.blobs}/${sha}`;
    if (!(await c.host.files.exists(blob))) await c.host.files.writeBinary(blob, (await c.host.files.readBinary(f)).base64);
  }
  const existing = (await c.host.files.exists(c.dir)) ? (await c.host.files.list(c.dir)).filter((x) => /(^|\/)base-\d+\.json$/.test(x)).length : 0;
  const id = `base-${existing + 1}`;
  await c.host.files.writeAtomic(manifestPath(c, id), JSON.stringify({ files: m }));
  return { id, kind: "manifest" };
}

async function manDiff(c: Ctx, id: string): Promise<string[] | undefined> {
  const manifest = JSON.parse((await c.host.files.read(manifestPath(c, id))).content) as { files: Record<string, string> };
  const now = await scan(c);
  if ("kind" in now) return undefined;
  const out = new Set<string>();
  for (const [f, sha] of Object.entries(now)) if (manifest.files[f] !== sha) out.add(f);
  for (const f of Object.keys(manifest.files)) if (!(f in now)) out.add(f);
  return [...out].sort();
}

async function manRestore(c: Ctx, id: string): Promise<{ restored: string[]; deleted: string[] }> {
  const manifest = JSON.parse((await c.host.files.read(manifestPath(c, id))).content) as { files: Record<string, string> };
  const now = await scan(c);
  if ("kind" in now) throw new Error(`change tracking unavailable: ${now.reason}`);
  const current = now;
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const f of Object.keys(current)) {
    if (SKIP.test(f) || c.ignored(f)) continue;
    if (!(f in manifest.files)) {
      await c.host.files.delete(f);
      deleted.push(f);
    }
  }
  for (const [f, sha] of Object.entries(manifest.files)) {
    if (current[f] === sha) continue;
    await c.host.files.writeBinary(f, (await c.host.files.readBinary(`${c.blobs}/${sha}`)).base64);
    restored.push(f);
  }
  return { restored: restored.sort(), deleted: deleted.sort() };
}

/**
 * Serialized change tracker: git worktrees checkpoint the whole tree through a temp index kept between calls
 * into `refs/stewart/<sessionId>`; other projects hash a manifest of project files with content-addressed blobs.
 */
export function changeTracker(host: Host, p: CpPaths): ChangeTracker {
  let tail: Promise<unknown> = Promise.resolve();
  let gitRepo: boolean | undefined;
  const dir = `${p.stateDir}/checkpoints/${p.sessionId}`;
  const indexFile = `${dir}.index`;
  /** Session state under stateDir (manifests, transcripts, .turn) is never the project's change. */
  const stateAbs = `${p.stateDir.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  const stateRel = `${path.relative(p.cwd, p.stateDir).replace(/\\/g, "/")}/`;
  const inState = (f: string) => f.startsWith(stateAbs) || (!stateRel.startsWith("..") && f.startsWith(stateRel));
  const c: Ctx = {
    host,
    p,
    indexFile,
    indexEnv: { GIT_INDEX_FILE: indexFile },
    ignored: (f) => IGNORED.test(f) || inState(f),
    dir,
    blobs: `${dir}/blobs`,
    isGit: async () => gitRepo ?? (gitRepo = await probeGit(c)),
  };
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = tail.then(fn, fn);
    tail = r.catch(() => undefined);
    return r;
  };
  return {
    begin: (label) => queued(async () => ((await c.isGit()) ? await gitBegin(c, label) : await manBegin(c))),
    baseline: (id) => queued(async () => ({ id, kind: (await c.isGit()) ? ("git" as const) : ("manifest" as const) })),
    diff: (b) => queued(async () => (b.kind === "unavailable" ? undefined : b.kind === "git" ? await gitDiff(c, b.id) : await manDiff(c, b.id))),
    restore: (b) =>
      queued(async () => {
        if (b.kind === "unavailable") throw new Error(`change tracking unavailable: ${b.reason ?? "unknown"}`);
        return b.kind === "git" ? await gitRestore(c, b.id) : await manRestore(c, b.id);
      }),
    dispose: () => queued(() => disposeTracker(c)),
  };
}

async function disposeTracker(c: Ctx): Promise<void> {
  for (const sub of [`${c.dir}/blobs`, c.dir]) {
    try {
      for (const name of await c.host.files.list(sub)) await c.host.files.delete(`${sub}/${name.split("/").pop() ?? name}`).catch(() => {});
    } catch {
      /* absent */
    }
  }
  await c.host.files.delete(c.indexFile).catch(() => {});
  if (await c.isGit()) await git(c.host, c.p.cwd, ["update-ref", "-d", `refs/stewart/${c.p.sessionId}`], c.indexEnv).catch(() => {});
}

async function probeGit(c: Ctx): Promise<boolean> {
  try {
    const r = await git(c.host, c.p.cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.out.trim() === "true";
  } catch {
    return false;
  }
}

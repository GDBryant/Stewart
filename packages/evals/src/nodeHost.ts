import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { HostPort, ProcessHandle, VersionedEdit } from "@stewart/core";

export interface NodeHostOpts {
  root: string;
  stateDir: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export function secretEnvName(ref: string): string {
  return `STEWART_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

async function atomicWrite(abs: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, abs);
}

function applyEdits(text: string, e: VersionedEdit): string {
  if (e.content !== undefined) return e.content;
  let out = text;
  for (const ed of e.edits ?? []) {
    const at = out.indexOf(ed.oldText);
    if (at < 0) throw new Error(`anchor not found in ${e.path}`);
    out = out.slice(0, at) + ed.newText + out.slice(at + ed.oldText.length);
  }
  return out;
}

async function walk(abs: string, rel: string, out: string[]): Promise<void> {
  for (const ent of await readdir(abs, { withFileTypes: true })) {
    if (out.length >= 20_000) return;
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) await walk(join(abs, ent.name), r, out);
    else if (ent.isFile()) out.push(r);
  }
}

function files(abs: (p: string) => string): HostPort["files"] {
  const readText = async (p: string) => readFile(abs(p), "utf8");
  return {
    read: async (p) => ({ content: await readText(p) }),
    edit: async (e) => {
      const current = e.content !== undefined ? "" : await readText(e.path);
      await atomicWrite(abs(e.path), applyEdits(current, e));
      return { applied: true as const };
    },
    readBack: readText,
    exists: async (p) => stat(abs(p)).then(() => true, () => false),
    list: async (dir) => {
      const out: string[] = [];
      const prefix = dir === "" || dir === "." ? "" : dir.replace(/\/+$/, "");
      await walk(abs(dir || "."), prefix, out);
      return out;
    },
    stat: async (p) => ({ size: (await stat(abs(p))).size }),
    readBinary: async (p) => {
      const buf = await readFile(abs(p));
      return { base64: buf.toString("base64"), size: buf.byteLength };
    },
    writeBinary: (p, b64) => atomicWrite(abs(p), Buffer.from(b64, "base64")),
    writeAtomic: (p, c) => atomicWrite(abs(p), c),
    appendLine: async (p, line) => {
      await mkdir(dirname(abs(p)), { recursive: true });
      await appendFile(abs(p), `${line}\n`);
    },
    readLines: async (p) => (await readText(p).catch(() => "")).split("\n").filter((l) => l.length > 0),
    delete: (p) => rm(abs(p), { force: true }),
  };
}

function run(argv: string[], opts: { cwd: string; env?: Record<string, string>; onData(d: string): void }): ProcessHandle {
  const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true });
  child.stdout?.on("data", (d: Buffer) => opts.onData(d.toString()));
  child.stderr?.on("data", (d: Buffer) => opts.onData(d.toString()));
  const done = new Promise<{ code: number }>((res) => {
    child.on("error", (e) => {
      opts.onData(`${e.message}\n`);
      res({ code: -1 });
    });
    child.on("close", (code) => res({ code: code ?? -1 }));
  });
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-(child.pid ?? 0), sig);
    } catch {
      child.kill(sig);
    }
  };
  return { write: (d) => child.stdin?.write(d), cancel: () => kill("SIGTERM"), killTree: async () => kill("SIGKILL"), done };
}

/** HostPort on plain Node: real files under `root`, real processes, secrets from `STEWART_SECRET_<REF>` env vars. */
export function nodeHost(o: NodeHostOpts): HostPort {
  const env = o.env ?? process.env;
  const extra = new Map<string, string>();
  const abs = (p: string) => (isAbsolute(p) ? p : join(o.root, p));
  return {
    secrets: {
      get: async (ref) => extra.get(ref) ?? env[secretEnvName(ref)],
      set: async (ref, v) => void extra.set(ref, v),
      delete: async (ref) => void extra.delete(ref),
    },
    files: files(abs),
    proc: { run },
    diff: { preview: async () => {} },
    diag: { problems: async () => [] },
    editor: { selection: async () => null },
    workspace: { roots: async () => [o.root], stateDir: async () => o.stateDir, trusted: async () => true },
    log: o.log ?? (() => {}),
  };
}

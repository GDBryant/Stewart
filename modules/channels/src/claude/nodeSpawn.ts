import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SpawnedProc {
  stdin(data: string): void;
  stdout: AsyncIterable<string>;
  stderrText(): Promise<string>;
  done: Promise<{ code: number }>;
  /** Kill the whole process tree. */
  kill(): Promise<void>;
}

export type SpawnFn = (argv: string[], opts: { cwd: string; env: Record<string, string> }) => SpawnedProc;

async function* lineIter(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += String(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

/** Collect up to 64 KiB of stderr; the returned getter reads what has been captured so far. */
function captureStderr(proc: ChildProcessWithoutNullStreams): () => string {
  let buf = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => {
    if (buf.length < 65536) buf += d.slice(0, 65536 - buf.length);
  });
  return () => buf;
}

/** Resolves with the exit code once the child closes, or -1 on spawn error. */
function exitOf(proc: Pick<ChildProcess, "on">): Promise<{ code: number }> {
  return new Promise<{ code: number }>((res) => {
    proc.on("close", (code: number | null) => res({ code: code ?? -1 }));
    proc.on("error", () => res({ code: -1 }));
  });
}

function signalGroup(proc: Pick<ChildProcess, "kill">, pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    proc.kill(sig);
  }
}

/** True if `done` settles within `ms`, polling every 25 ms. */
async function waitForExit(done: Promise<unknown>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 25))])) return true;
  }
  return false;
}

/** SIGTERM the process group, then SIGKILL it if it has not exited within 2 s. */
async function killTree(proc: Pick<ChildProcess, "pid" | "kill">, done: Promise<unknown>): Promise<void> {
  const pid = proc.pid;
  if (pid === undefined) return;
  signalGroup(proc, pid, "SIGTERM");
  if (await waitForExit(done, 2000)) return;
  signalGroup(proc, pid, "SIGKILL");
}

/** Default spawner: node child_process, detached group so kill() takes the tree. */
export const nodeSpawn: SpawnFn = (argv, opts) => {
  const proc = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const stderrText = captureStderr(proc);
  const done = exitOf(proc);
  return {
    stdin(data) {
      proc.stdin.write(data, () => proc.stdin.end());
    },
    stdout: lineIter(proc.stdout),
    stderrText: async () => {
      await done;
      return stderrText();
    },
    done,
    kill: () => killTree(proc, done),
  };
};

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "stewart-claude-"));
}

export async function writeTempFile(prefix: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const p = join(dir, "prompt.txt");
  await writeFile(p, content, "utf8");
  return p;
}

export async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

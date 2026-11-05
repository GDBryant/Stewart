import { spawn } from "node:child_process";
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

/** Default spawner: node child_process, detached group so kill() takes the tree. */
export const nodeSpawn: SpawnFn = (argv, opts) => {
  const proc = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderrBuf = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => {
    if (stderrBuf.length < 65536) stderrBuf += d.slice(0, 65536 - stderrBuf.length);
  });
  const done = new Promise<{ code: number }>((res) => {
    proc.on("close", (code) => res({ code: code ?? -1 }));
    proc.on("error", () => res({ code: -1 }));
  });
  return {
    stdin(data) {
      proc.stdin.write(data, () => proc.stdin.end());
    },
    stdout: lineIter(proc.stdout),
    stderrText: async () => {
      await done;
      return stderrBuf;
    },
    done,
    async kill() {
      const pid = proc.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await Promise.race([done.then(() => true), new Promise((r) => setTimeout(() => r(false), 25))])) return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    },
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

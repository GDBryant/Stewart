import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HostPort } from "@stewart/kernel";

/** A real-disk host for tests that need git: files resolve against root, commands spawn for real. */
export function nodeHost(root: string): Pick<HostPort, "files" | "proc"> {
  const abs = (p: string) => resolve(root, p);
  return {
    files: {
      read: async (p) => ({ content: readFileSync(abs(p), "utf8") }),
      edit: async () => ({ applied: true as const }),
      readBack: async (p) => readFileSync(abs(p), "utf8"),
      exists: async (p) => existsSync(abs(p)),
      list: async (d) => (readdirSync(abs(d), { recursive: true }) as string[]).map((f) => f.replace(/\\/g, "/")),
      stat: async (p) => ({ size: readFileSync(abs(p)).length }),
      readBinary: async (p) => ({ base64: readFileSync(abs(p)).toString("base64"), size: readFileSync(abs(p)).length }),
      writeBinary: async (p, b) => writeFileSync(abs(p), Buffer.from(b, "base64")),
      writeAtomic: async (p, c) => { mkdirSync(join(abs(p), ".."), { recursive: true }); writeFileSync(abs(p), c); },
      appendLine: async () => {},
      readLines: async () => [],
      delete: async (p) => { if (existsSync(abs(p))) rmSync(abs(p), { recursive: true }); },
    } as HostPort["files"],
    proc: {
      run: (argv, opts) => {
        const cp = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
        cp.stdout.on("data", (d) => opts.onData(String(d)));
        cp.stderr.on("data", (d) => opts.onData(String(d)));
        return {
          cancel: () => cp.kill(),
          killTree: async () => { cp.kill("SIGKILL"); },
          done: new Promise((r) => cp.on("close", (code) => r({ code: code ?? 1 }))),
        };
      },
    },
  };
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
}


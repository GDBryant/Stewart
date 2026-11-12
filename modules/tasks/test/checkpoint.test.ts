import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCheckpoint, revert, type CpPaths } from "../src/checkpoint.js";
import type { HostPort } from "@stewart/kernel";

function nodeHost(root: string): Pick<HostPort, "files" | "proc"> {
  const abs = (p: string) => resolve(root, p);
  return {
    files: {
      read: async (p) => ({ content: readFileSync(abs(p), "utf8") }),
      edit: async () => ({ applied: true as const }),
      readBack: async (p) => readFileSync(abs(p), "utf8"),
      exists: async (p) => existsSync(abs(p)),
      list: async () => [],
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

function sh(cwd: string, ...args: string[]): string {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
}

describe("checkpoints on a real git repo", () => {
  it("commits to refs/stewart without touching HEAD or the index, and reverts worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-git-"));
    const stateDir = join(root, ".state");
    mkdirSync(stateDir, { recursive: true });
    const host = nodeHost(root);
    sh(root, "git", "init", "-q");
    sh(root, "git", "config", "user.email", "t@t");
    sh(root, "git", "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    sh(root, "git", "add", "a.txt");
    sh(root, "git", "commit", "-qm", "init");
    const head0 = sh(root, "git", "rev-parse", "HEAD").trim();
    const p: CpPaths = { cwd: root, stateDir, sessionId: "s1" };

    const cp1 = await createCheckpoint(host, p, "start", ["a.txt"], 1);
    writeFileSync(join(root, "a.txt"), "two\n");
    writeFileSync(join(root, "b.txt"), "new\n");
    writeFileSync(join(root, "ignored.log"), "x\n");
    writeFileSync(join(root, ".gitignore"), "ignored.log\n");
    const cp2 = await createCheckpoint(host, p, "M1", ["a.txt", "b.txt"], 2);

    expect(sh(root, "git", "rev-parse", "HEAD").trim()).toBe(head0);
    expect(sh(root, "git", "status", "--porcelain").trim()).not.toBe("");
    const refs = sh(root, "git", "rev-list", "refs/stewart/s1").trim().split("\n");
    expect(refs).toContain(cp1);
    expect(refs).toContain(cp2);
    expect(sh(root, "git", "rev-parse", `${cp2}^` ).trim()).toBe(cp1);

    writeFileSync(join(root, "c.txt"), "later\n");
    writeFileSync(join(root, "a.txt"), "three\n");
    const r = await revert(host, p, cp2);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(root, "c.txt"))).toBe(false);
    expect(existsSync(join(root, "ignored.log"))).toBe(true);
    expect(r.restored).toContain("a.txt");
    expect(r.deleted).toContain("c.txt");

    await revert(host, p, cp1);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(sh(root, "git", "rev-parse", "HEAD").trim()).toBe(head0);
  });
});

describe("checkpoints without git", () => {
  it("snapshots session files and restores them on revert", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-snap-"));
    const stateDir = join(root, ".state");
    const host = nodeHost(root);
    const p: CpPaths = { cwd: root, stateDir, sessionId: "s2" };
    writeFileSync(join(root, "a.txt"), "one\n");

    const id = await createCheckpoint(host, p, "start", ["a.txt", "gone.txt"], 1);
    expect(id).toBe("snap-1");
    writeFileSync(join(root, "a.txt"), "two\n");
    writeFileSync(join(root, "gone.txt"), "x\n");
    const r = await revert(host, p, id);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    expect(r.restored).toEqual(["a.txt"]);
    expect(r.deleted).toEqual(["gone.txt"]);
  });
});

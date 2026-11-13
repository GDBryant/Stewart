import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCheckpoint, recordOriginal, revert, type CpPaths } from "../src/checkpoint.js";
import { nodeHost, sh } from "./nodeHost.js";

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

    const cp1 = await createCheckpoint(host, p, "start", ["a.txt"]);
    writeFileSync(join(root, "a.txt"), "two\n");
    writeFileSync(join(root, "b.txt"), "new\n");
    writeFileSync(join(root, "ignored.log"), "x\n");
    writeFileSync(join(root, ".gitignore"), "ignored.log\n");
    const cp2 = await createCheckpoint(host, p, "M1", ["a.txt", "b.txt"]);

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

  it("leaves .stewart/ (the plan file) alone on revert", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-git-plan-"));
    const stateDir = join(root, ".state");
    mkdirSync(join(root, ".stewart"), { recursive: true });
    const host = nodeHost(root);
    sh(root, "git", "init", "-q");
    sh(root, "git", "config", "user.email", "t@t");
    sh(root, "git", "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, ".stewart", "plan.md"), "M1 pending\n");
    sh(root, "git", "add", ".");
    sh(root, "git", "commit", "-qm", "init");
    const p: CpPaths = { cwd: root, stateDir, sessionId: "s3" };
    const cp1 = await createCheckpoint(host, p, "start", []);
    writeFileSync(join(root, "a.txt"), "two\n");
    writeFileSync(join(root, ".stewart", "plan.md"), "M1 done\n");
    const r = await revert(host, p, cp1);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(root, ".stewart", "plan.md"), "utf8")).toBe("M1 done\n");
    expect(r.restored).toContain("a.txt");
    expect(r.restored).not.toContain(".stewart/plan.md");
  });
});

describe("checkpoints without git", () => {
  it("snapshots session files and restores them on revert", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-snap-"));
    const stateDir = join(root, ".state");
    const host = nodeHost(root);
    const p: CpPaths = { cwd: root, stateDir, sessionId: "s2" };
    writeFileSync(join(root, "a.txt"), "one\n");

    const id = await createCheckpoint(host, p, "start", ["a.txt", "gone.txt"]);
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

describe("snapshot checkpoints: copy-on-write originals", () => {
  it("baseline revert restores pre-write content and deletes files created later; milestone revert keeps that milestone", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-cow-"));
    const stateDir = join(root, ".state");
    const host = nodeHost(root);
    const p: CpPaths = { cwd: root, stateDir, sessionId: "s4" };
    writeFileSync(join(root, "a.txt"), "orig\n");
    const base = await createCheckpoint(host, p, "start", []);
    // M1: edit a.txt
    await recordOriginal(host, p, "a.txt", "orig\n");
    writeFileSync(join(root, "a.txt"), "m1\n");
    const m1 = await createCheckpoint(host, p, "M1", ["a.txt"]);
    // M2: create b.txt, edit a.txt again
    await recordOriginal(host, p, "b.txt", null);
    writeFileSync(join(root, "b.txt"), "new\n");
    writeFileSync(join(root, "a.txt"), "m2\n");
    expect([base, m1]).toEqual(["snap-1", "snap-2"]);

    let r = await revert(host, p, m1);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("m1\n");
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(r.deleted).toEqual(["b.txt"]);

    writeFileSync(join(root, "b.txt"), "again\n");
    r = await revert(host, p, base);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("orig\n");
    expect(existsSync(join(root, "b.txt"))).toBe(false);
  });

  it("recordOriginal never overwrites a recorded path and is a no-op without manifests", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-cow2-"));
    const host = nodeHost(root);
    const p: CpPaths = { cwd: root, stateDir: join(root, ".state"), sessionId: "s5" };
    await recordOriginal(host, p, "x.txt", "ignored");
    expect(existsSync(join(root, ".state"))).toBe(false);
    writeFileSync(join(root, "x.txt"), "one\n");
    const id = await createCheckpoint(host, p, "start", ["x.txt"]);
    await recordOriginal(host, p, "x.txt", "other\n");
    writeFileSync(join(root, "x.txt"), "two\n");
    await revert(host, p, id);
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("one\n");
  });
});

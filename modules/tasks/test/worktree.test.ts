import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeChanges, worktreeState } from "../src/worktree.js";
import { nodeHost, sh } from "./nodeHost.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  sh(root, "git", "init", "-q");
  sh(root, "git", "config", "user.email", "t@t");
  sh(root, "git", "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  sh(root, "git", "add", ".");
  sh(root, "git", "commit", "-qm", "init");
  return root;
}

describe("worktree change detection", () => {
  it("sees edits, re-edits of dirty files, new and deleted files; ignores .stewart/ and .claude/", async () => {
    const root = repo();
    const host = nodeHost(root);
    writeFileSync(join(root, "a.txt"), "dirty before\n");
    const before = await worktreeState(host, root);
    expect(before?.size).toBe(1);
    writeFileSync(join(root, "a.txt"), "dirty after\n");
    rmSync(join(root, "b.txt"));
    writeFileSync(join(root, "c.txt"), "new\n");
    mkdirSync(join(root, ".stewart"));
    writeFileSync(join(root, ".stewart", "plan.md"), "x\n");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.local.json"), "{}\n");
    const after = await worktreeState(host, root);
    expect(worktreeChanges(before, after)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("reports no change when nothing changed, and a file reverted to HEAD as changed", async () => {
    const root = repo();
    const host = nodeHost(root);
    const s0 = await worktreeState(host, root);
    expect(worktreeChanges(s0, await worktreeState(host, root))).toEqual([]);
    writeFileSync(join(root, "a.txt"), "x\n");
    const s1 = await worktreeState(host, root);
    writeFileSync(join(root, "a.txt"), "a\n");
    expect(worktreeChanges(s1, await worktreeState(host, root))).toEqual(["a.txt"]);
  });

  it("is unknown outside a git repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-none-"));
    const st = await worktreeState(nodeHost(root), root);
    expect(st).toBeUndefined();
    expect(worktreeChanges(st, new Map())).toBeUndefined();
  });
});

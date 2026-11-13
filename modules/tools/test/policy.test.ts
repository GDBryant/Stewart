import { describe, expect, it } from "vitest";
import { actionOf, decide } from "../src/policy.js";
import type { RoleDef } from "@stewart/config";

const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 25, ...over,
});
const reader = (over: Partial<RoleDef> = {}): RoleDef => role({ tools: ["ReadFile", "RunTerminal"], ...over });
const writer = (over: Partial<RoleDef> = {}): RoleDef => role({ tools: ["WriteFile", "RunTerminal"], ...over });

describe("decide: write", () => {
  it("allows a normal project path for an unrestricted role", () => {
    expect(decide(role(), { kind: "write", path: "src/a.ts" })).toEqual({ allow: true });
  });
  it("denies absolute and .. paths as outside the project", () => {
    for (const p of ["/etc/x", "../outside.txt", "..\\up.txt"]) {
      const d = decide(writer(), { kind: "write", path: p });
      expect(d.allow).toBe(false);
      expect((d as { reason: string }).reason).toContain("outside the project");
    }
  });
  it("denies .git and .stewart except .stewart/scratch", () => {
    for (const p of [".git/config", ".stewart/plans/x.md", ".stewart/foo"]) {
      expect(decide(writer(), { kind: "write", path: p }).allow).toBe(false);
    }
    expect(decide(writer(), { kind: "write", path: ".stewart/scratch/x.txt" })).toEqual({ allow: true });
    expect(decide(writer(), { kind: "write", path: ".stewart/scratch" })).toEqual({ allow: true });
  });
  it("denies writes for read-only roles", () => {
    const d = decide(reader({ id: "reviewer" }), { kind: "write", path: "src/a.ts" });
    expect(d).toEqual({ allow: false, reason: "read-only role 'reviewer' cannot edit files" });
  });
  it("enforces writePaths globs", () => {
    const r = writer({ writePaths: ["tests/**"] });
    expect(decide(r, { kind: "write", path: "tests/a.test.ts" })).toEqual({ allow: true });
    const d = decide(r, { kind: "write", path: "src/a.ts" });
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toContain("outside this role's writePaths");
  });
});

describe("decide: command", () => {
  it("denies when the role's tool list lacks RunTerminal", () => {
    const d = decide(role({ tools: ["ReadFile"] }), { kind: "command", command: "ls" });
    expect(d).toEqual({ allow: false, reason: "role 'r' has no RunTerminal tool" });
  });
  it("allows when the role has RunTerminal or no tool list", () => {
    expect(decide(writer(), { kind: "command", command: "anything" })).toEqual({ allow: true });
    expect(decide(role(), { kind: "command", command: "rm -rf x" })).toEqual({ allow: true });
  });
  it("applies the read-only program allow-list", () => {
    const r = reader({ id: "investigator" });
    expect(decide(r, { kind: "command", command: "ls -la" })).toEqual({ allow: true });
    const d = decide(r, { kind: "command", command: "rm x" });
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toContain("not allowed for read-only role investigator");
  });
});

describe("decide: other + actionOf", () => {
  it("always allows other actions", () => {
    expect(decide(reader(), { kind: "other" })).toEqual({ allow: true });
  });
  it("maps previews to actions", () => {
    expect(actionOf({ kind: "file", path: "a.ts" } as never)).toEqual({ kind: "write", path: "a.ts" });
    expect(actionOf({ kind: "command", command: "ls" } as never)).toEqual({ kind: "command", command: "ls" });
    expect(actionOf(null)).toEqual({ kind: "other" });
  });
});

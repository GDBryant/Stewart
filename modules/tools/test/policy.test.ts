import { describe, expect, it } from "vitest";
import { actionOf, checkReadOnlyCommand, decide } from "../src/policy.js";
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

describe("checkReadOnlyCommand", () => {
  const allowed = [
    "ls -la 2>&1",
    "grep -rn foo src 2>/dev/null",
    "ls >/dev/null",
    "ls &>/dev/null",
    "ls 2>/dev/null | sort | uniq -c",
    "cut -d: -f1 a.txt | tr a-z A-Z",
    "basename a/b.ts",
    "dirname a/b.ts",
    "date",
    "tree -L 2",
    "node --version",
    "node -v",
    "python3 --version",
    "pnpm --version && git status",
    "uniq a.txt",
    "find . -name '*.ts'",
    "find . -executable",
    "git branch",
    "git branch -a",
    "git branch --show-current",
    "git log --oneline",
    "rg foo src",
    "git --version",
    "foo --version",
  ];
  it.each(allowed)("allows %s", (command) => {
    expect(() => checkReadOnlyCommand(command, "investigator")).not.toThrow();
  });

  const refused = [
    "ls > out",
    "ls >> /dev/null",
    "ls 2>err",
    "cat < f",
    'node -e "1"',
    "git push",
    "rm x",
    "echo x | sh -v",
    "./tool --version",
    "node --version x",
    "sort -o out a",
    "sort --output=out a",
    "tree -o out",
    "date -s 2020-01-01",
    "uniq a b",
    "node --version; rm x",
    "find . -delete",
    "find . -execdir rm {} ;",
    "find . -fprintf out %p",
    "find . -exec rm {} ;",
    "find . -fprint out",
    "git branch -D main",
    "git branch newb",
    "git log --output=f",
    "git diff --output f",
    "rg --pre rm x",
    "rm -v",
    "fc-cache -v",
    "pkill -v",
  ];
  it.each(refused)("refuses %s", (command) => {
    expect(() => checkReadOnlyCommand(command, "investigator")).toThrow(/not allowed for read-only role investigator/);
  });

  it.each(["pnpm test", "vitest run", "npx vitest"])("refuses %s with a tester hint", (command) => {
    expect(() => checkReadOnlyCommand(command, "investigator")).toThrow(/delegate to tester/);
  });
  it("does not add the hint to a non-runner refusal", () => {
    expect(() => checkReadOnlyCommand("rm x", "investigator")).toThrow(/not allowed for read-only role investigator$/);
  });
});

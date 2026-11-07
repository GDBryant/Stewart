import { describe, expect, it } from "vitest";
import { Grants, categoryOf, isScratchPath, splitShellPrograms, type ToolPreview } from "../src/api.js";

const cmd = (command: string): ToolPreview => ({ kind: "command", command, cwd: "/w" });
const file = (path: string): ToolPreview => ({ kind: "file", path, before: null, after: "x" });

describe("splitShellPrograms", () => {
  it("lists the programs of each sub-command", () => {
    expect(splitShellPrograms("git status && ls -la | wc -l")).toEqual(["git", "ls", "wc"]);
  });
  it("returns null for shells, launchers, interpreters and state changes", () => {
    for (const c of ["bash -c 'ls'", "sudo ls", "python3 x.py", "export A=1", "cd /tmp && ls"]) expect(splitShellPrograms(c), c).toBeNull();
  });
});

describe("categoryOf", () => {
  it("maps previews to categories; tool override wins", () => {
    expect(categoryOf(file("a"))).toBe("EDITS");
    expect(categoryOf(cmd("ls"))).toBe("COMMANDS");
    expect(categoryOf({ kind: "other" })).toBe("OTHER");
    expect(categoryOf(null)).toBeNull();
    expect(categoryOf(file("a"), { category: "MCP:x" })).toBe("MCP:x");
  });
});

describe("Grants", () => {
  it("auto-grants scratch paths and audits them; other paths need a grant", () => {
    const g = new Grants();
    expect(isScratchPath(".stewart/scratch/n.txt")).toBe(true);
    expect(g.isGranted("EDITS", file("scratch/a"))).toBe(true);
    expect(g.audit[0].decision).toBe("auto");
    expect(g.isGranted("EDITS", file("src/a.ts"))).toBe(false);
  });
  it("program grants cover a command only when every program is granted", () => {
    const g = new Grants();
    g.record("chat", "COMMANDS", cmd("git status"));
    expect(g.isGranted("COMMANDS", cmd("git log"))).toBe(true);
    expect(g.isGranted("COMMANDS", cmd("git log | rm -rf x"))).toBe(false);
  });
  it("unparseable commands fall back to a category grant; revoke clears by scope", () => {
    const g = new Grants();
    g.record("always", "COMMANDS", cmd("bash -c x"));
    expect(g.isGranted("COMMANDS", cmd("anything"))).toBe(true);
    g.revoke("chat");
    expect(g.isGranted("COMMANDS", cmd("anything"))).toBe(true);
    g.revoke("always", "COMMANDS");
    expect(g.isGranted("COMMANDS", cmd("anything"))).toBe(false);
  });
});

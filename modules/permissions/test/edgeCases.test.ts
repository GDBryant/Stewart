import { describe, expect, it } from "vitest";
import { categoryOf, Grants, splitShellPrograms, type ToolPreview } from "../src/api.js";

const cmd = (command: string): ToolPreview => ({ kind: "command", command, cwd: "/w" });
const file = (path: string): ToolPreview => ({ kind: "file", path, before: null, after: "x" });

describe("splitShellPrograms edge cases", () => {
  it("handles double-quoted strings with escaped quotes and backslashes", () => {
    expect(splitShellPrograms('echo "a\\"b" && ls')).toEqual(["echo", "ls"]);
  });

  it("keeps escaped characters outside quotes", () => {
    expect(splitShellPrograms("echo a\\ b")).toEqual(["echo"]);
  });

  it("returns null for backticks and $( ) substitutions", () => {
    expect(splitShellPrograms("echo `id`")).toBeNull();
    expect(splitShellPrograms("echo $(id)")).toBeNull();
  });

  it("returns null for an unterminated quote", () => {
    expect(splitShellPrograms("echo 'oops")).toBeNull();
    expect(splitShellPrograms('echo "oops')).toBeNull();
  });

  it("skips variable assignments, rejects dangerous ones", () => {
    expect(splitShellPrograms("FOO=1 BAR=2 ls")).toEqual(["ls"]);
    expect(splitShellPrograms("PATH=/evil ls")).toBeNull();
    expect(splitShellPrograms("NODE_OPTIONS=--inspect node x.js")).toBeNull();
  });

  it("returns null when the line is only assignments or separators", () => {
    expect(splitShellPrograms("FOO=1")).toBeNull();
    expect(splitShellPrograms("   ")).toBeNull();
    expect(splitShellPrograms("ls ; && wc")).toEqual(["ls", "wc"]);
  });

  it("a quoted-empty program word skips the segment", () => {
    expect(splitShellPrograms("'' ls")).toBeNull();
    expect(splitShellPrograms('""')).toBeNull();
    expect(splitShellPrograms("'' ; ls")).toEqual(["ls"]);
  });
});

describe("categoryOf edge cases", () => {
  it("honours an explicit other-category and returns null for unknown kinds", () => {
    expect(categoryOf({ kind: "other", category: "NET" })).toBe("NET");
    expect(categoryOf({ kind: "weird" } as ToolPreview)).toBeNull();
  });
});

describe("Grants.revoke", () => {
  it("revokes per scope and per category", () => {
    const g = new Grants();
    const unsplittable = cmd("sudo ls");
    g.record("chat", "COMMANDS", unsplittable);
    g.record("always", "COMMANDS", unsplittable);
    g.record("always", "EDITS", file("a"));
    g.revoke("chat", "COMMANDS");
    expect(g.isGranted("COMMANDS", unsplittable)).toBe(true);
    g.revoke("always", "COMMANDS");
    expect(g.isGranted("COMMANDS", unsplittable)).toBe(false);
    expect(g.isGranted("EDITS", file("a"))).toBe(true);
    g.revoke();
    expect(g.isGranted("EDITS", file("a"))).toBe(false);
  });

  it("revoke of only one scope leaves the other intact", () => {
    const g = new Grants();
    g.record("chat", "EDITS", file("a"));
    g.record("always", "EDITS", file("a"));
    g.revoke("chat");
    expect(g.isGranted("EDITS", file("a"))).toBe(true);
    g.revoke("always");
    expect(g.isGranted("EDITS", file("a"))).toBe(false);
  });
});

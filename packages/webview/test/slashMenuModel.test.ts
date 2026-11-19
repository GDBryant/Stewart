import { describe, expect, it } from "vitest";
import type { SlashCommandInfo } from "@stewart/protocol";
import { slashMenuComplete, slashMenuFilter, slashMenuMove, slashMenuOpen } from "../src/slashMenuModel.js";

const cmds: SlashCommandInfo[] = [
  { name: "help", argHint: "", description: "List commands" },
  { name: "init", aliases: ["ini"], argHint: "", description: "Init the project" },
  { name: "clear", aliases: ["new"], argHint: "", description: "Clear the chat" },
];

describe("slashMenuOpen", () => {
  it("opens only on a single-slash draft", () => {
    expect(slashMenuOpen("/")).toBe(true);
    expect(slashMenuOpen("/cl")).toBe(true);
    expect(slashMenuOpen("/CLEAR")).toBe(true);
    expect(slashMenuOpen("//x")).toBe(false);
    expect(slashMenuOpen("/clear now")).toBe(false);
    expect(slashMenuOpen("hello /x")).toBe(false);
    expect(slashMenuOpen("")).toBe(false);
    expect(slashMenuOpen("/bad_cmd")).toBe(false);
  });
});

describe("slashMenuFilter", () => {
  it("filters by name or alias prefix, case-insensitive", () => {
    expect(slashMenuFilter(cmds, "/").map((c) => c.name)).toEqual(["help", "init", "clear"]);
    expect(slashMenuFilter(cmds, "/cl").map((c) => c.name)).toEqual(["clear"]);
    expect(slashMenuFilter(cmds, "/CL").map((c) => c.name)).toEqual(["clear"]);
    expect(slashMenuFilter(cmds, "/new").map((c) => c.name)).toEqual(["clear"]);
    expect(slashMenuFilter(cmds, "/zzz")).toEqual([]);
  });
});

describe("slashMenuMove", () => {
  it("wraps the selection both ways", () => {
    expect(slashMenuMove(0, 3, -1)).toBe(2);
    expect(slashMenuMove(2, 3, 1)).toBe(0);
    expect(slashMenuMove(1, 3, 1)).toBe(2);
    expect(slashMenuMove(0, 0, 1)).toBe(0);
  });
});

describe("slashMenuComplete", () => {
  it("returns /name with a trailing space", () => {
    expect(slashMenuComplete(cmds[0])).toBe("/help ");
  });
});

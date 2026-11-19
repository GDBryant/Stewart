import { describe, expect, it } from "vitest";
import { parseSlash, slashPlainText } from "../src/api.js";

describe("parseSlash", () => {
  it("parses name and args, lowercases the name", () => {
    expect(parseSlash("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlash("/INIT  foo bar ")).toEqual({ name: "init", args: "foo bar" });
  });

  it("returns null for plain text, double slash, and bare slash", () => {
    expect(parseSlash("hello /help")).toBeNull();
    expect(parseSlash("//literal")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("/ ")).toBeNull();
  });
});

describe("slashPlainText", () => {
  it("strips one leading slash only", () => {
    expect(slashPlainText("//literal")).toBe("/literal");
    expect(slashPlainText("plain")).toBe("plain");
    expect(slashPlainText("/cmd")).toBe("/cmd");
  });
});

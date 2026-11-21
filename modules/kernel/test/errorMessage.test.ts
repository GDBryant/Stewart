import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/api.js";

describe("errorMessage", () => {
  it("uses Error.message", () => expect(errorMessage(new Error("boom"))).toBe("boom"));
  it("stringifies non-errors", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

import { describe, expect, it } from "vitest";
import { roleSchema } from "../src/schema.js";

describe("roleSchema distinctFrom", () => {
  const base = { id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 10 };

  it("defaults to an empty list when the key is absent", () => {
    expect(roleSchema.parse(base).distinctFrom).toEqual([]);
  });

  it("accepts a list of role ids", () => {
    expect(roleSchema.parse({ ...base, distinctFrom: ["planner"] }).distinctFrom).toEqual(["planner"]);
  });

  it("rejects a non-array value", () => {
    expect(() => roleSchema.parse({ ...base, distinctFrom: "planner" })).toThrow();
  });
});

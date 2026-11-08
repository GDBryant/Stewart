import { describe, expect, it } from "vitest";
import { agentSchema } from "../src/schema.js";

describe("agent costs flag", () => {
  it("accepts optional boolean", () => {
    expect(agentSchema.parse({ id: "a", channel: "c", model: "m", costs: true }).costs).toBe(true);
    expect(agentSchema.parse({ id: "a", channel: "c", model: "m" }).costs).toBeUndefined();
  });
  it("rejects non-boolean", () => {
    expect(agentSchema.safeParse({ id: "a", channel: "c", model: "m", costs: "yes" }).success).toBe(false);
  });
});

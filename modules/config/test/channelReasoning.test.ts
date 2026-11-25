import { describe, expect, it } from "vitest";
import { channelSchema } from "../src/schema.js";

const base = { id: "a", type: "openai-compatible" };

describe("channel reasoning field", () => {
  it("defaults to none", () => {
    expect(channelSchema.parse(base).reasoning).toBe("none");
  });

  it("accepts the two request fields and a reasoningControl cap", () => {
    expect(channelSchema.parse({ ...base, reasoning: "reasoning_effort" }).reasoning).toBe("reasoning_effort");
    const c = channelSchema.parse({ ...base, reasoning: "enable_thinking", modelCaps: { m: { reasoningControl: false } } });
    expect(c.modelCaps.m.reasoningControl).toBe(false);
  });

  it("rejects an unknown field name", () => {
    expect(channelSchema.safeParse({ ...base, reasoning: "bogus" }).success).toBe(false);
  });
});

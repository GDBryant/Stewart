import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { EXPLORATION_RULES, systemPrompt } from "../src/lead.js";
import { makeConfig } from "./harness.js";

describe("lead system prompt", () => {
  it("carries the role prompt, the exploration rules, then the skills index", async () => {
    const config = makeConfig();
    const p = await systemPrompt(fakeHost().host, config.roles[0], config);
    expect(p.startsWith("You are lead.")).toBe(true);
    expect(p).toContain(EXPLORATION_RULES);
    expect(p).toContain("Search and FindFiles");
    expect(p.indexOf("# Exploration")).toBeLessThan(p.indexOf("# Skills"));
    expect(p).toContain("sk1");
  });

  it("points health checks at the project-health skill and health_batches", () => {
    expect(EXPLORATION_RULES).toContain("load_skill project-health");
    expect(EXPLORATION_RULES).toContain("health_batches");
  });

  it("adds the rules even when the role has no prompt of its own", async () => {
    const config = makeConfig();
    const p = await systemPrompt(fakeHost().host, { ...config.roles[0], prompt: undefined }, config);
    expect(p).toContain("# Exploration");
  });
});

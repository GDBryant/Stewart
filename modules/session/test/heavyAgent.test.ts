import { describe, expect, it } from "vitest";
import type { AgentDef, RoleDef } from "@stewart/config";
import { heavyFirst } from "../src/heavyAgent.js";
import { makeConfig } from "./harness.js";

const QUAL = { passed: true, at: 1, version: 2, context: 32000 };
const small: AgentDef = { id: "small", channel: "c", model: "s", effort: "medium" };
const big: AgentDef = { id: "big", channel: "c", model: "b", effort: "medium" };
const cfg = (over: { enabled?: boolean; bigQualified?: boolean } = {}) => {
  const base = makeConfig();
  return makeConfig({
    agents: [small, big],
    channels: [{ ...base.channels[0], enabled: over.enabled ?? true, modelCaps: { s: { qualified: { agent: QUAL } }, b: over.bigQualified === false ? {} : { qualified: { agent: { ...QUAL, context: 128000 } } } } }],
  });
};
const role = (over: Partial<RoleDef> = {}): RoleDef => ({ id: "lead", enabled: true, prompt: "", skills: [], tools: [], writePaths: [], turnBudget: 60, agent: "small", ...over });

describe("heavyFirst", () => {
  it("puts the heavy agent first for a milestone task, the normal chain after it", () => {
    expect(heavyFirst(role({ heavyAgent: "big" }), [small], cfg(), true).map((a) => a.id)).toEqual(["big", "small"]);
  });

  it("does not duplicate an agent already in the chain", () => {
    expect(heavyFirst(role({ heavyAgent: "big" }), [small, big], cfg(), true).map((a) => a.id)).toEqual(["big", "small"]);
    expect(heavyFirst(role({ heavyAgent: "big" }), [big, small], cfg(), true).map((a) => a.id)).toEqual(["big", "small"]);
  });

  it("leaves the chain alone for non-milestone tasks, with no heavyAgent, or when the heavy agent is unusable", () => {
    const chain = [small];
    expect(heavyFirst(role({ heavyAgent: "big" }), chain, cfg(), false)).toBe(chain);
    expect(heavyFirst(role({}), chain, cfg(), true)).toBe(chain);
    expect(heavyFirst(role({ heavyAgent: "ghost" }), chain, cfg(), true)).toBe(chain);
    expect(heavyFirst(role({ heavyAgent: "big" }), chain, cfg({ bigQualified: false }), true)).toBe(chain);
    expect(heavyFirst(role({ heavyAgent: "big" }), chain, cfg({ enabled: false }), true)).toBe(chain);
  });
});

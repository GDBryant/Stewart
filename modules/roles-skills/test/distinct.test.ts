import { describe, expect, it } from "vitest";
import type { AgentDef, RoleDef } from "@stewart/config";
import { avoidedModels, distinctWarnings, pickIndependent, primaryAgent } from "../src/api.js";

const ag = (id: string, channel: string, model: string): AgentDef => ({ id, channel, model, effort: "medium" });
const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 5, distinctFrom: [], ...over,
});

describe("primaryAgent", () => {
  it("returns the role's bound agent", () => {
    const agents = [ag("a1", "c1", "m1"), ag("a2", "c2", "m2")];
    expect(primaryAgent(role({ id: "planner", agent: "a1" }), [role({ id: "planner", agent: "a1" })], agents)).toEqual(ag("a1", "c1", "m1"));
  });

  it("falls to the lead's chain when unbound", () => {
    const agents = [ag("a1", "c1", "m1"), ag("a2", "c2", "m2")];
    const roles = [role({ id: "lead", agent: "a2" }), role({ id: "planner" })];
    expect(primaryAgent(roles[1], roles, agents)).toEqual(ag("a2", "c2", "m2"));
  });

  it("is undefined when no agent is reachable", () => {
    expect(primaryAgent(role({ id: "planner" }), [role({ id: "planner" })], [])).toBeUndefined();
  });
});

describe("avoidedModels", () => {
  it("collects the channel/model keys of distinctFrom roles' primary agents", () => {
    const agents = [ag("a1", "c1", "m1"), ag("a2", "c2", "m2")];
    const roles = [
      role({ id: "planner", agent: "a1" }),
      role({ id: "investigator", agent: "a2" }),
      role({ id: "interrogator", agent: "a1", distinctFrom: ["planner", "investigator"] }),
    ];
    expect(avoidedModels(roles[2], roles, agents)).toEqual(new Set(["c1/m1", "c2/m2"]));
  });

  it("ignores unknown ids, self references and disabled roles", () => {
    const agents = [ag("a1", "c1", "m1"), ag("a2", "c2", "m2")];
    const roles = [
      role({ id: "off", enabled: false, agent: "a1" }),
      role({ id: "me", agent: "a2", distinctFrom: ["ghost", "me", "off"] }),
    ];
    expect(avoidedModels(roles[1], roles, agents)).toEqual(new Set());
  });

  it("is empty when the role has no distinctFrom", () => {
    const agents = [ag("a1", "c1", "m1")];
    const roles = [role({ id: "me", agent: "a1" })];
    expect(avoidedModels(roles[0], roles, agents)).toEqual(new Set());
  });
});

describe("distinctWarnings", () => {
  const W = "independent review is weakened — bind a different model";
  it("warns exactly once for two roles sharing a model", () => {
    const agents = [ag("a1", "c1", "m1")];
    const roles = [
      role({ id: "planner", agent: "a1" }),
      role({ id: "interrogator", agent: "a1", distinctFrom: ["planner"] }),
    ];
    expect(distinctWarnings(roles, agents)).toEqual([`warning: role interrogator: shares model c1/m1 with planner (distinctFrom); ${W}`]);
  });

  it("does not warn when the roles use different models", () => {
    const agents = [ag("a1", "c1", "m1"), ag("a3", "c2", "m9")];
    const roles = [
      role({ id: "planner", agent: "a1" }),
      role({ id: "interrogator", agent: "a3", distinctFrom: ["planner"] }),
    ];
    expect(distinctWarnings(roles, agents)).toEqual([]);
  });

  it("does not warn for a disabled role", () => {
    const agents = [ag("a1", "c1", "m1")];
    const roles = [
      role({ id: "planner", agent: "a1" }),
      role({ id: "interrogator", enabled: false, agent: "a1", distinctFrom: ["planner"] }),
    ];
    expect(distinctWarnings(roles, agents)).toEqual([]);
  });

  it("keys on channel/model, not agent id", () => {
    const agents = [ag("a1", "c1", "m1"), ag("a4", "c1", "m1")];
    const roles = [
      role({ id: "planner", agent: "a1" }),
      role({ id: "interrogator", agent: "a4", distinctFrom: ["planner"] }),
    ];
    expect(distinctWarnings(roles, agents)).toEqual([`warning: role interrogator: shares model c1/m1 with planner (distinctFrom); ${W}`]);
  });

  it("orders warnings by roles order then distinctFrom order", () => {
    const agents = [ag("a1", "c1", "m1")];
    const roles = [
      role({ id: "planner", agent: "a1" }),
      role({ id: "investigator", agent: "a1" }),
      role({ id: "interrogator", agent: "a1", distinctFrom: ["investigator", "planner"] }),
    ];
    expect(distinctWarnings(roles, agents)).toEqual([
      `warning: role interrogator: shares model c1/m1 with investigator (distinctFrom); ${W}`,
      `warning: role interrogator: shares model c1/m1 with planner (distinctFrom); ${W}`,
    ]);
  });
});

describe("pickIndependent", () => {
  it("prefers a different agent when one is available", () => {
    expect(pickIndependent([ag("a1", "c1", "m1"), ag("a3", "c2", "m9")], new Set(["c1/m1"])))
      .toEqual({ agent: ag("a3", "c2", "m9"), independent: true });
  });

  it("falls back to the first agent when nothing differs", () => {
    expect(pickIndependent([ag("a1", "c1", "m1")], new Set(["c1/m1"])))
      .toEqual({ agent: ag("a1", "c1", "m1"), independent: false });
  });

  it("treats an empty avoid set as independent", () => {
    expect(pickIndependent([ag("a1", "c1", "m1")], new Set()))
      .toEqual({ agent: ag("a1", "c1", "m1"), independent: true });
  });

  it("returns no agent but independent for an empty chain", () => {
    expect(pickIndependent([], new Set(["c1/m1"]))).toEqual({ agent: undefined, independent: true });
  });
});

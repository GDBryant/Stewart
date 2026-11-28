import { describe, expect, it } from "vitest";
import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { heavyAgentErrors, LONG_BUDGET, roleWindowWarnings } from "../src/roleWindow.js";

const QUAL = { passed: true, at: 1, version: 2 };
const agent = (id: string, model: string): AgentDef => ({ id, channel: "c", model, effort: "medium" });
const channel = (windows: Record<string, number | undefined>): ChannelDef => ({
  id: "c",
  type: "ollama",
  enabled: true,
  discoverModels: true,
  extraModels: [],
  modelCaps: Object.fromEntries(Object.entries(windows).map(([m, ctx]) => [m, { qualified: { agent: { ...QUAL, ...(ctx ? { context: ctx } : {}) } } }])),
});
const role = (over: Partial<RoleDef>): RoleDef => ({ id: "worker", enabled: true, prompt: "", skills: [], tools: [], writePaths: [], turnBudget: 60, agent: "small", ...over });
const agents = [agent("small", "s"), agent("big", "b")];
const channels = [channel({ s: 32_000, b: 128_000 })];

const leadRole = () => role({ id: "lead", agent: "big", turnBudget: 25 });

describe("roleWindowWarnings", () => {
  it("warns for a 32k agent on a role whose budget is over 40", () => {
    const w = roleWindowWarnings([leadRole(), role({})], agents, channels, 60);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^warning: role worker: agent 'small' has a 32000-token window but the turn budget is 60/);
    expect(w[0]).toContain("heavyAgent");
  });

  it("the lead uses the effective run limit, not its role turnBudget", () => {
    const lead = role({ id: "lead", turnBudget: 5 });
    expect(roleWindowWarnings([lead], agents, channels, 60)).toHaveLength(1);
    expect(roleWindowWarnings([lead], agents, channels, LONG_BUDGET)).toEqual([]);
  });

  it("a fallback active lead also uses the run limit, whatever its id or turnBudget", () => {
    const fallback = role({ id: "worker", turnBudget: 5 });
    expect(roleWindowWarnings([role({ id: "lead", enabled: false }), fallback], agents, channels, 60)).toHaveLength(1);
    expect(roleWindowWarnings([fallback], agents, channels, 60)).toHaveLength(1);
    expect(roleWindowWarnings([fallback], agents, channels, LONG_BUDGET)).toEqual([]);
  });

  it("unlimited budgets warn and say so", () => {
    expect(roleWindowWarnings([leadRole(), role({ turnBudget: "unlimited" })], agents, channels, 60)[0]).toContain("turn budget is unlimited");
  });

  it("no warning for a short budget (≤ 40), a larger window, an unknown window, a disabled or function role, or no agent", () => {
    expect(roleWindowWarnings([leadRole(), role({ turnBudget: 40 })], agents, channels, 60)).toEqual([]);
    expect(roleWindowWarnings([leadRole(), role({ agent: "big" })], agents, channels, 60)).toEqual([]);
    expect(roleWindowWarnings([leadRole(), role({})], agents, [channel({ s: undefined })], 60)).toEqual([]);
    expect(roleWindowWarnings([leadRole(), role({ enabled: false })], agents, channels, 60)).toEqual([]);
    expect(roleWindowWarnings([leadRole(), role({ kind: "function" })], agents, channels, 60)).toEqual([]);
    expect(roleWindowWarnings([leadRole(), role({ agent: undefined })], agents, channels, 60)).toEqual([]);
    expect(roleWindowWarnings([leadRole(), role({ agent: "ghost" })], agents, channels, 60)).toEqual([]);
  });
});

describe("heavyAgentErrors", () => {
  it("accepts a qualified agent; flags an unknown one and one the role refuses", () => {
    expect(heavyAgentErrors([role({ heavyAgent: "big" })], agents, channels)).toEqual([]);
    expect(heavyAgentErrors([role({ heavyAgent: "ghost" })], agents, channels)).toEqual(["role worker: unknown heavyAgent 'ghost'"]);
    const unq: ChannelDef[] = [{ ...channels[0], modelCaps: { b: {} } }];
    expect(heavyAgentErrors([role({ heavyAgent: "big" })], agents, unq)[0]).toMatch(/^role worker: heavyAgent 'big' not usable: /);
  });

  it("ignores roles that are disabled or have no heavyAgent", () => {
    expect(heavyAgentErrors([role({ enabled: false, heavyAgent: "ghost" }), role({})], agents, channels)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { eligibleChain, roleChainIds, roleNeeds, chainErrors } from "../src/chain.js";

const agent = (id: string): AgentDef => ({ id, channel: "c", model: "m", effort: "medium" });
const chan = (qualified?: Record<string, { passed: boolean; at: number; version: number }>): ChannelDef => ({
  id: "c",
  type: "ollama",
  enabled: true,
  discoverModels: true,
  extraModels: [],
  modelCaps: { m: { qualified } },
});
const role = (over: Partial<RoleDef>): RoleDef => ({ id: "r", enabled: true, prompt: "", skills: [], tools: ["ReadFile"], writePaths: [], turnBudget: 5, ...over });

describe("roleChainIds", () => {
  const agents = [agent("a1"), agent("a2")];
  it("uses the explicit chain, then agent, then the lead chain, then first agent", () => {
    const lead = role({ id: "lead", chain: ["a2", "a1"] });
    expect(roleChainIds(role({ chain: ["a1"] }), [lead], agents)).toEqual(["a1"]);
    expect(roleChainIds(role({ agent: "a2" }), [lead], agents)).toEqual(["a2"]);
    expect(roleChainIds(role({}), [lead], agents)).toEqual(["a2", "a1"]);
    expect(roleChainIds(role({ id: "lead" }), [], agents)).toEqual(["a1"]);
  });
});

describe("roleNeeds", () => {
  it("defaults to agent minimums", () => {
    expect(roleNeeds(role({}))).toEqual({ vision: false, minContext: 32000 });
    expect(roleNeeds(role({ needs: { vision: true, minContext: 8000 } }))).toEqual({ vision: true, minContext: 8000 });
  });
});

describe("eligibleChain", () => {
  const agents = [agent("a1"), agent("a2"), agent("a3")];
  it("orders passed first in chain order, then unknown; failed are excluded", () => {
    const ch = chan({ agent: { passed: true, at: 1, version: 1 } });
    const lead = role({ id: "lead", chain: ["a1", "a2", "a3"] });
    expect(eligibleChain(lead, [lead], agents, [ch]).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    const failed = chan({ agent: { passed: false, at: 1, version: 1 } });
    expect(eligibleChain(lead, [lead], agents, [failed])).toEqual([]);
  });

  it("puts unknown after qualified and uses the function kind for function roles", () => {
    const ch: ChannelDef = {
      id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [],
      modelCaps: {
        m1: { qualified: { agent: { passed: true, at: 1, version: 1 } } },
        m2: {},
        m3: { qualified: { agent: { passed: true, at: 1, version: 1 } } },
      },
    };
    const as = [
      { id: "a1", channel: "c", model: "m1", effort: "medium" as const },
      { id: "a2", channel: "c", model: "m2", effort: "medium" as const },
      { id: "a3", channel: "c", model: "m3", effort: "medium" as const },
    ];
    const lead = role({ id: "lead", chain: ["a2", "a3", "a1"] });
    expect(eligibleChain(lead, [lead], as, [ch]).map((a) => a.id)).toEqual(["a3", "a1", "a2"]);
    const fnRole = role({ id: "lead", kind: "function", chain: ["a1", "a2"] });
    expect(eligibleChain(fnRole, [fnRole], as, [ch]).map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

describe("chainErrors", () => {
  it("flags unknown agents and failed qualification records", () => {
    const ch: ChannelDef = {
      id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [],
      modelCaps: { m: { qualified: { agent: { passed: false, at: 1, version: 1 } } } },
    };
    const r = role({ chain: ["a1", "ghost"] });
    const errs = chainErrors(r, [agent("a1")], [ch]);
    expect(errs.join(";")).toContain("failed agent qualification");
    expect(errs.join(";")).toContain("unknown chain agent 'ghost'");
    expect(chainErrors(role({}), [agent("a1")], [ch])).toEqual([]);
  });
});

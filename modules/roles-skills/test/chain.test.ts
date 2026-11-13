import { describe, expect, it } from "vitest";
import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { agentRefusal, eligibleChain, roleChainIds, roleNeeds, chainErrors } from "../src/chain.js";

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
  it("needs no minimum window for function roles unless set", () => {
    expect(roleNeeds(role({ kind: "function" })).minContext).toBe(0);
    expect(roleNeeds(role({ kind: "function", needs: { minContext: 4000 } })).minContext).toBe(4000);
  });
});

describe("eligibleChain", () => {
  const agents = [agent("a1"), agent("a2"), agent("a3")];
  it("orders passed first in chain order, then unknown; failed are excluded", () => {
    const ch = chan({ agent: { passed: true, at: 1, version: 2, context: 32000 } });
    const lead = role({ id: "lead", chain: ["a1", "a2", "a3"] });
    expect(eligibleChain(lead, [lead], agents, [ch]).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    const failed = chan({ agent: { passed: false, at: 1, version: 2 } });
    expect(eligibleChain(lead, [lead], agents, [failed])).toEqual([]);
  });

  it("excludes unqualified agents, keeps chain order, and uses the kind for function roles", () => {
    const ch: ChannelDef = {
      id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [],
      modelCaps: {
        m1: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } },
        m2: {},
        m3: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } },
      },
    };
    const as = [
      { id: "a1", channel: "c", model: "m1", effort: "medium" as const },
      { id: "a2", channel: "c", model: "m2", effort: "medium" as const },
      { id: "a3", channel: "c", model: "m3", effort: "medium" as const },
    ];
    const lead = role({ id: "lead", chain: ["a2", "a3", "a1"] });
    expect(eligibleChain(lead, [lead], as, [ch]).map((a) => a.id)).toEqual(["a3", "a1"]);
    const fnRole = role({ id: "lead", kind: "function", chain: ["a1", "a2"] });
    expect(eligibleChain(fnRole, [fnRole], as, [ch]).map((a) => a.id)).toEqual([]);
  });

  it("enforces the role's minimum context window at run time", () => {
    const q = { agent: { passed: true, at: 1, version: 2, context: 32000 } };
    const ch: ChannelDef = {
      id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [],
      modelCaps: { small: { qualified: q, contextTokens: 8000 }, big: { qualified: q, contextTokens: 64000 } },
    };
    const as = [
      { id: "s", channel: "c", model: "small", effort: "medium" as const },
      { id: "b", channel: "c", model: "big", effort: "medium" as const },
    ];
    const lead = role({ id: "lead", chain: ["s", "b"] });
    expect(eligibleChain(lead, [lead], as, [ch]).map((a) => a.id)).toEqual(["b"]);
    const lenient = role({ id: "lead", chain: ["s", "b"], needs: { minContext: 4000 } });
    expect(eligibleChain(lenient, [lenient], as, [ch]).map((a) => a.id)).toEqual(["s", "b"]);
  });
});

describe("agentRefusal", () => {
  const caps = (m: Record<string, unknown>): ChannelDef => ({ id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [], modelCaps: { m } });
  const fnQ = { function: { passed: true, at: 1, version: 2, context: 32000 } };
  it("lets a small qualified model serve a function role but not an agent role", () => {
    const small = caps({ qualified: { ...fnQ, agent: { passed: true, at: 1, version: 2, context: 32000 } }, contextTokens: 8000 });
    expect(agentRefusal(role({ kind: "function" }), agent("a"), [small])).toBeNull();
    expect(agentRefusal(role({}), agent("a"), [small])).toContain("context window 8000 < 32000");
  });
  it("admits the verified window in the record, refuses an unknown window, missing qualification and missing vision", () => {
    expect(agentRefusal(role({}), agent("a"), [caps({ qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } })])).toBeNull();
    expect(agentRefusal(role({}), agent("a"), [caps({ qualified: { agent: { passed: true, at: 1, version: 2 } } })])).toBe("context window unknown (run Qualify)");
    expect(agentRefusal(role({ kind: "function" }), agent("a"), [caps({ qualified: { agent: { passed: true, at: 1, version: 2 }, function: { passed: true, at: 1, version: 2 } } })])).toBeNull();
    expect(agentRefusal(role({}), agent("a"), [caps({ qualified: { agent: { passed: true, at: 1, version: 1, context: 32000 } } })])).toBe("qualification out of date (run Qualify)");
    expect(agentRefusal(role({}), agent("a"), [caps({})])).toContain("not qualified as agent");
    const noVision = caps({ qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } });
    expect(agentRefusal(role({ needs: { vision: true } }), agent("a"), [noVision])).toBe("role needs vision");
    const vision = caps({ qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } }, vision: true });
    expect(agentRefusal(role({ needs: { vision: true } }), agent("a"), [vision])).toBeNull();
  });
});

describe("chainErrors", () => {
  it("flags unknown agents and failed qualification records", () => {
    const ch: ChannelDef = {
      id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [],
      modelCaps: { m: { qualified: { agent: { passed: false, at: 1, version: 2 } } } },
    };
    const r = role({ chain: ["a1", "ghost"] });
    const errs = chainErrors(r, [agent("a1")], [ch]);
    expect(errs.join(";")).toContain("failed agent qualification");
    expect(errs.join(";")).toContain("unknown chain agent 'ghost'");
    expect(chainErrors(role({}), [agent("a1")], [ch])).toEqual([]);
  });
  it("flags a bound agent that is unqualified; disabled roles are not checked", () => {
    const ch = chan(undefined);
    expect(chainErrors(role({ agent: "a1" }), [agent("a1")], [ch])).toEqual(["role r: agent 'a1' not qualified as agent (run Qualify)"]);
    expect(chainErrors(role({ agent: "a1", enabled: false }), [agent("a1")], [ch])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig, type AgentDef, type ChannelDef, type RoleDef } from "@stewart/config";
import { agentRefusal, divertTarget, eligibleChain, effectiveEffort, roleChainIds, roleNeeds, chainErrors } from "../src/chain.js";

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
  it("uses [agent, secondary] deduped, then the lead's chain, then first agent", () => {
    const lead = role({ id: "lead", agent: "a2", secondary: "a1" });
    expect(roleChainIds(role({ agent: "a1", secondary: "a2" }), [lead], agents)).toEqual(["a1", "a2"]);
    expect(roleChainIds(role({ agent: "a1", secondary: "a1" }), [lead], agents)).toEqual(["a1"]);
    expect(roleChainIds(role({ agent: "a2" }), [lead], agents)).toEqual(["a2"]);
    expect(roleChainIds(role({}), [lead], agents)).toEqual(["a2", "a1"]);
    expect(roleChainIds(role({ secondary: "a1" }), [lead], agents)).toEqual(["a2", "a1"]);
    expect(roleChainIds(role({ agent: "a3" }), [lead], agents)).toEqual(["a3"]);
    expect(roleChainIds(role({ id: "lead" }), [], agents)).toEqual(["a1"]);
  });
});

describe("effectiveEffort", () => {
  it("role override wins, then the agent value, then medium", () => {
    const hi: AgentDef = { id: "a", channel: "c", model: "m", effort: "high" };
    const lo: AgentDef = { id: "a", channel: "c", model: "m", effort: "low" };
    expect(effectiveEffort(role({}), hi)).toBe("high");
    expect(effectiveEffort(role({ effort: "max" }), lo)).toBe("max");
    expect(effectiveEffort(role({ effort: "low" }), hi)).toBe("low");
    expect(effectiveEffort(role({}), agent("a"))).toBe("medium");
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
    const lead = role({ id: "lead", agent: "a1", secondary: "a2" });
    expect(eligibleChain(lead, [lead], agents, [ch]).map((a) => a.id)).toEqual(["a1", "a2"]);
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
    const lead = role({ id: "lead", agent: "a2", secondary: "a3" });
    expect(eligibleChain(lead, [lead], as, [ch]).map((a) => a.id)).toEqual(["a3"]);
    const fnRole = role({ id: "lead", kind: "function", agent: "a1", secondary: "a2" });
    expect(eligibleChain(fnRole, [fnRole], as, [ch]).map((a) => a.id)).toEqual([]);
  });

  it("drops the stale chain override in a real roles.yaml (agent updated, chain left behind)", () => {
    const rolesYaml = `version: 1
items:
  - id: lead
    enabled: true
    agent: AI Factory-glm-5-3-flash
    chain: [AI Factory-glm-5-3-flash]
  - id: reviewer
    enabled: true
    agent: AI Factory-glm-5-3-flash
    chain: [local-ollama-ornith-1-5-9b]
  - id: tester
    enabled: true
    agent: AI Factory-glm-5-3-flash
    chain: [local-ollama-qwen3-5-4b]
`;
    const cfg = loadConfig({ "roles.yaml": rolesYaml }, undefined, {}, { trusted: true });
    expect(cfg.errors).toEqual([]);
    const q = { agent: { passed: true, at: 1, version: 2, context: 32000 } };
    const channels: ChannelDef[] = [
      { id: "aif", type: "openai-compatible", enabled: true, discoverModels: true, extraModels: [], modelCaps: { "glm-5-3-flash": { qualified: { agent: { ...q.agent, context: 200000 } } } } },
      { id: "o", type: "ollama", enabled: true, discoverModels: true, extraModels: [], modelCaps: { "ornith-1.5:9b": { qualified: q }, "qwen3.5:4b": { qualified: q } } },
    ];
    const as: AgentDef[] = [
      { id: "AI Factory-glm-5-3-flash", channel: "aif", model: "glm-5-3-flash", effort: "medium" },
      { id: "local-ollama-ornith-1-5-9b", channel: "o", model: "ornith-1.5:9b", effort: "medium" },
      { id: "local-ollama-qwen3-5-4b", channel: "o", model: "qwen3.5:4b", effort: "medium" },
    ];
    for (const id of ["lead", "reviewer", "tester"]) {
      const r = cfg.roles.find((x) => x.id === id)!;
      expect(eligibleChain(r, cfg.roles, as, channels).map((a) => a.id)).toEqual(["AI Factory-glm-5-3-flash"]);
    }
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
    const lead = role({ id: "lead", agent: "s", secondary: "b" });
    expect(eligibleChain(lead, [lead], as, [ch]).map((a) => a.id)).toEqual(["b"]);
    const lenient = role({ id: "lead", agent: "s", secondary: "b", needs: { minContext: 4000 } });
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
    const r = role({ agent: "a1", secondary: "ghost" });
    const errs = chainErrors(r, [agent("a1")], [ch]);
    expect(errs.join(";")).toContain("failed agent qualification");
    expect(errs.join(";")).toContain("unknown secondary agent 'ghost'");
    expect(chainErrors(role({}), [agent("a1")], [ch])).toEqual([]);
  });
  it("flags a bound agent that is unqualified; disabled roles are not checked", () => {
    const ch = chan(undefined);
    expect(chainErrors(role({ agent: "a1" }), [agent("a1")], [ch])).toEqual(["role r: agent 'a1' not qualified as agent (run Qualify)"]);
    expect(chainErrors(role({ agent: "a1", enabled: false }), [agent("a1")], [ch])).toEqual([]);
  });
});

describe("divertTarget", () => {
  const q = { agent: { passed: true, at: 1, version: 2, context: 32000 } };
  const capChan = (caps: Record<string, { qualified?: typeof q; reasoning?: boolean; contextTokens?: number }>): ChannelDef => ({
    id: "c", type: "ollama", enabled: true, discoverModels: true, extraModels: [], modelCaps: caps,
  });
  const A = (id: string, model: string, effort: AgentDef["effort"] = "medium"): AgentDef => ({ id, channel: "c", model, effort });
  const allQ = { m1: { qualified: q }, m2: { qualified: q }, m3: { qualified: q } };
  const opts = (over: Partial<Parameters<typeof divertTarget>[0]> = {}) => ({
    candidates: [A("a2", "m2"), A("a3", "m3")],
    tried: ["a1"],
    current: A("a1", "m1"),
    role: role({ agent: "a1" }),
    channels: [capChan(allQ)],
    ...over,
  });
  it("picks an eligible reasoning-capable candidate ranked by window then effort, skipping tried/current/unqualified", () => {
    const ch = capChan({
      m1: { qualified: q },
      m2: { qualified: q, reasoning: true, contextTokens: 32000 },
      m3: { qualified: q, reasoning: true, contextTokens: 64000 },
    });
    expect(divertTarget(opts({ channels: [ch] }))?.id).toBe("a3");
    expect(divertTarget(opts({ channels: [ch], tried: ["a1", "a3"] }))?.id).toBe("a2");
    expect(divertTarget(opts({ channels: [ch], tried: ["a1", "a2", "a3"] }))).toBeUndefined();
  });
  it("reasoning-capable ranks above unknown, then wider window, then deeper effort, then stable order", () => {
    const reasoningWins = capChan({ m1: { qualified: q }, m2: { qualified: q, reasoning: true, contextTokens: 32000 }, m3: { qualified: q, contextTokens: 128000 } });
    expect(divertTarget(opts({ channels: [reasoningWins] }))?.id).toBe("a2");
    const windowWins = capChan({ m1: { qualified: q }, m2: { qualified: q, contextTokens: 64000 }, m3: { qualified: q, contextTokens: 32000 } });
    expect(divertTarget(opts({ channels: [windowWins] }))?.id).toBe("a2");
    const sameWin = capChan({ m1: { qualified: q }, m2: { qualified: q, contextTokens: 32000 }, m3: { qualified: q, contextTokens: 32000 } });
    expect(divertTarget(opts({ channels: [sameWin], candidates: [A("a2", "m2", "low"), A("a3", "m3", "high")] }))?.id).toBe("a3");
    expect(divertTarget(opts({ channels: [sameWin], candidates: [A("a2", "m2"), A("a3", "m3")] }))?.id).toBe("a2");
  });
  it("excludes agents that agentRefusal refuses, even if otherwise capable", () => {
    const refused = capChan({
      m1: { qualified: q, vision: true },
      m2: { qualified: q, reasoning: true, contextTokens: 32000, vision: true },
      m3: { qualified: { agent: { passed: true, at: 1, version: 2 } }, vision: true }, // window unknown → refused
    });
    expect(divertTarget(opts({ role: role({ agent: "a1", needs: { vision: true } }), channels: [refused] }))?.id).toBe("a2");
    expect(divertTarget(opts({ channels: [refused] }))?.id).toBe("a2");
  });
  it("an explicit target wins when eligible; when ineligible it falls back to the auto-ranking", () => {
    const ch = capChan({ m1: { qualified: q }, m2: { qualified: q, reasoning: true, contextTokens: 64000 }, m3: { qualified: q } });
    expect(divertTarget(opts({ channels: [ch], explicit: "a3" }))?.id).toBe("a3");
    expect(divertTarget(opts({ channels: [ch], explicit: "ghost" }))?.id).toBe("a2");
    expect(divertTarget(opts({ channels: [ch], explicit: "a2", tried: ["a1", "a2"] }))?.id).toBe("a3");
    const noVision = capChan({ m1: { qualified: q }, m2: { qualified: q, reasoning: true, contextTokens: 32000 }, m3: { qualified: q, vision: true } });
    expect(divertTarget(opts({ role: role({ agent: "a1", needs: { vision: true } }), channels: [noVision], explicit: "a2" }))?.id).toBe("a3");
  });
  it("returns undefined when nothing is eligible", () => {
    expect(divertTarget(opts({ candidates: [] }))).toBeUndefined();
    expect(divertTarget(opts({ tried: ["a1", "a2", "a3"] }))).toBeUndefined();
    const unq = capChan({ m1: { qualified: q }, m2: {}, m3: {} });
    expect(divertTarget(opts({ channels: [unq] }))).toBeUndefined();
  });
});

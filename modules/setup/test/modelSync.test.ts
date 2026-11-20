import { describe, expect, it } from "vitest";
import type { AgentDef, RoleDef } from "@stewart/config";
import { agentIdBase, applyDecisions, billingFor, diffModels, mintAgent, uniqueAgentId } from "../src/modelSync.js";

const agent = (id: string, channel: string, model: string): AgentDef => ({ id, channel, model, effort: "medium" });
const role = (id: string, o: { agent?: string; secondary?: string } = {}): RoleDef =>
  ({ id, enabled: true, kind: "agent", skills: [], tools: [], writePaths: [], turnBudget: 25, ...o }) as RoleDef;

describe("diffModels", () => {
  it("reports listed models without agents as added and unlisted agent models as gone", () => {
    const agents = [agent("a1", "c1", "m1"), agent("a2", "c1", "m2"), agent("a3", "c2", "m9")];
    const roles = [role("lead", { agent: "a2" }), role("helper", { secondary: "a2" }), role("other", { agent: "a3" })];
    const d = diffModels(agents, roles, [{ id: "c1", type: "ollama", models: ["m1", "m3"] }]);
    expect(d.added).toEqual([{ channel: "c1", model: "m3", channelType: "ollama" }]);
    expect(d.gone.map((g) => g.agent.id)).toEqual(["a2"]);
    expect(d.gone[0].roles.sort()).toEqual(["helper", "lead"]);
  });

  it("never marks agents on unlisted (unreachable) channels as gone", () => {
    const d = diffModels([agent("a1", "c1", "m1"), agent("a2", "c2", "m2")], [], [{ id: "c1", type: "ollama", models: ["m1"] }]);
    expect(d.gone).toEqual([]);
    expect(d.added).toEqual([]);
  });

  it("treats extraModels merged into the list as present", () => {
    const d = diffModels([agent("a1", "c1", "extra")], [], [{ id: "c1", type: "ollama", models: ["extra"] }]);
    expect(d.gone).toEqual([]);
  });

  it("counts a model on a different channel as new", () => {
    const d = diffModels([agent("a1", "c1", "m1")], [], [{ id: "c2", type: "openai-compatible", models: ["m1"] }]);
    expect(d.added).toEqual([{ channel: "c2", model: "m1", channelType: "openai-compatible" }]);
  });
});

describe("mintAgent", () => {
  it("sanitizes the model into the id and dedupes with a numeric suffix", () => {
    expect(agentIdBase("c1", "big:32b-q4_K/M")).toBe("c1-big-32b-q4_K-M");
    expect(uniqueAgentId("c1-m", (id) => id === "c1-m" || id === "c1-m-2")).toBe("c1-m-3");
  });

  it("mints a priced agent when the catalog reports a price", () => {
    const a = mintAgent({ channel: "c1", model: "m:1", channelType: "openai-compatible", price: { inPerMTok: 1.25 }, taken: () => false });
    expect(a).toMatchObject({ id: "c1-m-1", channel: "c1", model: "m:1", effort: "medium", billing: "priced", price: { inPerMTok: 1.25, outPerMTok: 1.25 } });
  });

  it("derives billing from channel type when unpriced", () => {
    expect(billingFor("ollama", undefined)).toBe("free");
    expect(billingFor("claude-cli", undefined)).toBe("reported");
    expect(billingFor("openai-compatible", undefined)).toBe("unmetered");
    expect(billingFor("openai-compatible", 0)).toBe("free");
    const a = mintAgent({ channel: "c1", model: "m", channelType: "claude-cli", taken: () => false });
    expect(a).toMatchObject({ billing: "reported", costs: true });
  });
});

describe("applyDecisions", () => {
  const docs = {
    agents: [{ id: "a1" }, { id: "a2", custom: "keep" }],
    roles: [{ id: "lead", agent: "a2", secondary: "a1" }, { id: "helper", agent: "a3" }],
    channels: [{ id: "c1", enabled: true, baseUrl: "http://x" }, { id: "c2", enabled: true }],
  };

  it("removes agents, appends new ones and unbinds roles while keeping other fields", () => {
    const r = applyDecisions(docs, { addAgents: [{ id: "a9", channel: "c1", model: "m3" }], removeAgents: new Set(["a2"]) });
    expect(r.changed).toBe(true);
    expect(r.agents.map((a) => a.id)).toEqual(["a1", "a9"]);
    const lead = r.roles.find((x) => x.id === "lead")!;
    expect(lead.agent).toBeUndefined();
    expect(lead.secondary).toBe("a1");
    expect(r.roles.find((x) => x.id === "helper")!.agent).toBe("a3");
    expect(docs.agents).toHaveLength(2);
  });

  it("disables and removes channels", () => {
    const r = applyDecisions(docs, { disableChannels: new Set(["c1"]), removeChannels: new Set(["c2"]) });
    expect(r.channels).toEqual([{ id: "c1", enabled: false, baseUrl: "http://x" }]);
  });

  it("reports unchanged when decisions touch nothing", () => {
    const r = applyDecisions(docs, {});
    expect(r.changed).toBe(false);
    expect(r.agents).toEqual(docs.agents);
  });
});

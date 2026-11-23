import { describe, expect, it } from "vitest";
import { cascadeRemoval, detectIdChange, repointRename } from "../src/cascade.js";

describe("cascadeRemoval", () => {
  const docs = {
    agents: [
      { id: "a1", channel: "c1", model: "m" },
      { id: "a2", channel: "c2", model: "m", custom: "keep" },
    ],
    roles: [
      { id: "lead", agent: "a2", secondary: "a1" },
      { id: "helper", agent: "a1" },
      { id: "sub", secondary: "a2" },
    ],
  };

  it("drops only the removed channel's agents and resets bound roles", () => {
    const res = cascadeRemoval(docs, { channels: new Set(["c2"]) });
    expect(res.changed).toBe(true);
    expect(res.removedAgents).toEqual(["a2"]);
    expect(res.resetRoles.sort()).toEqual(["lead", "sub"]);
    expect(res.agents).toEqual([{ id: "a1", channel: "c1", model: "m" }]);
    expect(res.roles.find((r) => r.id === "lead")).toEqual({ id: "lead", agent: "a1" }); // secondary promoted
    expect(res.roles.find((r) => r.id === "helper")).toEqual({ id: "helper", agent: "a1" });
    expect(res.roles.find((r) => r.id === "sub")).toEqual({ id: "sub" });
  });

  it("removes explicitly listed agents even when the channel set is empty", () => {
    const res = cascadeRemoval(docs, { agents: new Set(["a1"]) });
    expect(res.removedAgents).toEqual(["a1"]);
    expect(res.agents).toEqual([{ id: "a2", channel: "c2", model: "m", custom: "keep" }]);
    expect(res.roles.find((r) => r.id === "lead")).toEqual({ id: "lead", agent: "a2" });
    expect(res.roles.find((r) => r.id === "helper")).toEqual({ id: "helper" });
  });

  it("reports unchanged for unknown ids and returns the same rows", () => {
    const res = cascadeRemoval(docs, { channels: new Set(["c9"]), agents: new Set(["a9"]) });
    expect(res.changed).toBe(false);
    expect(res.removedAgents).toEqual(["a9"]);
    expect(res.roles[0]).toBe(docs.roles[0]);
    expect(res.agents[0]).toBe(docs.agents[0]);
  });

  it("promotes a legacy chain tail instead of resurrecting a removed head", () => {
    const res = cascadeRemoval({ agents: [], roles: [{ id: "helper", chain: ["a2", "a1"] }] }, { agents: new Set(["a2"]) });
    expect(res.roles[0]).toEqual({ id: "helper", agent: "a1" });
  });
});

describe("detectIdChange", () => {
  const prev = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("sees one id gone and one new at the same index as a rename", () => {
    expect(detectIdChange(prev, [{ id: "a" }, { id: "b2" }, { id: "c" }])).toEqual({ removed: [], renamed: { from: "b", to: "b2" } });
    expect(detectIdChange(prev, [{ id: "a" }, { id: "a" }, { id: "c" }])).toEqual({ removed: [], renamed: { from: "b", to: "a" } });
  });

  it("sees a plain removal, and removal+add at a different index as removals", () => {
    expect(detectIdChange(prev, [{ id: "a" }, { id: "c" }])).toEqual({ removed: ["b"] });
    expect(detectIdChange(prev, [{ id: "a" }, { id: "c" }, { id: "d" }])).toEqual({ removed: ["b"] });
    expect(detectIdChange(prev, [{ id: "a" }, { id: "c" }, { id: "b2" }])).toEqual({ removed: ["b"] });
  });

  it("sees two gone as removals and no diff as nothing", () => {
    expect(detectIdChange(prev, [{ id: "a" }])).toEqual({ removed: ["b", "c"] });
    expect(detectIdChange(prev, prev)).toEqual({ removed: [] });
  });
});

describe("repointRename", () => {
  const docs = {
    agents: [{ id: "a1", channel: "c1" }, { id: "a2", channel: "c2", keep: 1 }],
    roles: [{ id: "lead", agent: "a1", secondary: "a2" }, { id: "helper", chain: ["a2", "a1"] }],
  };

  it("re-points agents' channel on a channel rename", () => {
    const res = repointRename(docs, "channel", { from: "c2", to: "c3" });
    expect(res.changed).toBe(true);
    expect(res.agents).toEqual([{ id: "a1", channel: "c1" }, { id: "a2", channel: "c3", keep: 1 }]);
    expect(res.roles[0]).toBe(docs.roles[0]);
  });

  it("re-points roles' agent, secondary and chain on an agent rename", () => {
    const res = repointRename(docs, "agent", { from: "a2", to: "a9" });
    expect(res.roles[0]).toEqual({ id: "lead", agent: "a1", secondary: "a9" });
    expect(res.roles[1]).toEqual({ id: "helper", chain: ["a9", "a1"] });
    expect(res.agents[0]).toBe(docs.agents[0]);
  });

  it("reports unchanged when nothing references the old id", () => {
    const res = repointRename(docs, "agent", { from: "zz", to: "yy" });
    expect(res.changed).toBe(false);
    expect(res.roles[0]).toBe(docs.roles[0]);
  });
});

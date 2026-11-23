import { describe, expect, it } from "vitest";
import { Core } from "../src/core.js";
import { withSessionQualified } from "../src/handlers/qualify.js";
import { fakeFetcher, fakeHost } from "@stewart/kernel";
import type { ConfigLayer } from "@stewart/config";
import type { ConfigStore } from "@stewart/config";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}

const defaults = {
  "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    modelCaps: { m1: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } }, m2: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } }, 'qwen3:32b': { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } }, 'gemma4:e4b': { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } } }\n",
  "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
};

const chatReply = (content: string) => [`{"message":{"content":${JSON.stringify(content)}},"done":false}`, '{"done":true}'];

function mk(responses: { status?: number; body?: string | string[] }[]) {
  const { fetcher, calls } = fakeFetcher(responses);
  const core = new Core({
    fetcher,
    defaults,
    userConfig: memStore(),
    projectConfig: async () => memStore(),
    emitEvent: () => {},
  });
  return { core, calls };
}

describe("setup.recommend", () => {
  it("returns parsed assignments from a streamed JSON answer", async () => {
    const answer = JSON.stringify({ assignments: [{ role: "lead", channel: "c1", model: "m2", reason: "strong tools" }] });
    const { core, calls } = mk([{ body: ['{"models":[{"name":"m1"},{"name":"m2"}]}'] }, { body: chatReply(answer) }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p" })) as {
      ok: boolean;
      assignments: { role: string; channel: string; model: string; reason?: string }[];
      researcher: { channel: string; model: string };
      channels: { id: string; models: string[] }[];
    };
    expect(r.ok).toBe(true);
    expect(r.assignments).toEqual([{ role: "lead", channel: "c1", model: "m2", reason: "strong tools" }]);
    expect(r.researcher).toEqual({ channel: "c1", model: "m1" });
    expect(r.channels[0].models).toEqual(["m1", "m2"]);
    expect(calls.map((c) => c.url)).toEqual(["http://oll/api/tags", "http://oll/api/chat"]);
  });

  it("parses a fenced reply wrapped in prose", async () => {
    const answer = `Here is the plan:\n\`\`\`json\n{"assignments":[{"role":"lead","channel":"c1","model":"m1"}]}\n\`\`\`\nHope that helps.`;
    const { core } = mk([{ body: ['{"models":[{"name":"m1"}]}'] }, { body: chatReply(answer) }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p" })) as { ok: boolean; error?: string; assignments: { role: string }[] };
    expect(r.ok).toBe(true);
    expect(r.assignments).toEqual([{ role: "lead", channel: "c1", model: "m1", reason: undefined }]);
  });

  it("fails with the raw reply when no JSON object is found", async () => {
    const { core } = mk([{ body: ['{"models":[{"name":"m1"}]}'] }, { body: chatReply("no json here at all") }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p" })) as { ok: boolean; error: string; raw?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not parse recommendation");
    expect(r.raw).toContain("no json here");
  });

  it("drops assignments to unknown roles or models with reasons", async () => {
    const answer = JSON.stringify({
      assignments: [
        { role: "lead", channel: "c1", model: "m2" },
        { role: "ghost-role", channel: "c1", model: "m1" },
        { role: "lead", channel: "c1", model: "nope" },
        { role: "lead", channel: "gone", model: "m1" },
      ],
    });
    const { core } = mk([{ body: ['{"models":[{"name":"m1"},{"name":"m2"}]}'] }, { body: chatReply(answer) }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p" })) as {
      ok: boolean;
      assignments: { role: string }[];
      dropped: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].role).toBe("lead");
    expect(r.dropped).toHaveLength(3);
    expect(r.dropped.join(" ")).toContain("unknown role");
    expect(r.dropped.join(" ")).toContain("unknown model");
    expect(r.dropped.join(" ")).toContain("unknown channel");
  });

  it("fails when every assignment is invalid", async () => {
    const answer = JSON.stringify({ assignments: [{ role: "nope", channel: "c1", model: "m1" }] });
    const { core } = mk([{ body: ['{"models":[{"name":"m1"}]}'] }, { body: chatReply(answer) }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p" })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty or invalid");
  });

  it("fails fast when no models are discovered", async () => {
    const { core, calls } = mk([{ body: ['{"models":[]}'] }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p" })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no models discovered");
    expect(calls).toHaveLength(1);
  });

  it("passes excludeChannels through: an excluded channel is not discovered or assigned", async () => {
    const answer = JSON.stringify({ assignments: [{ role: "lead", channel: "c2", model: "m1" }] });
    // With c1 excluded only c2 is fetched: response 1 = c2 model list, response 2 = researcher reply.
    const { fetcher, calls } = fakeFetcher([{ body: ['{"models":[{"name":"m1"},{"name":"m2"}]}'] }, { body: chatReply(answer) }]);
    const core = new Core({
      fetcher,
      defaults,
      userConfig: memStore({
        // c2 needs a qualified record for its model, else the agent hard-refusal drops the assignment
        "channels.yaml": "version: 1\nitems:\n  - id: c2\n    type: ollama\n    baseUrl: http://oll2\n    modelCaps: { m1: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } } }\n",
      }),
      projectConfig: async () => memStore(),
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", excludeChannels: ["c1"] })) as {
      ok: boolean;
      channels: { id: string; models: string[] }[];
      assignments: { channel: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.channels.map((c) => c.id)).toEqual(["c2"]);
    expect(calls.map((c) => c.url)).toEqual(["http://oll2/api/tags", "http://oll2/api/chat"]); // c1 never fetched
    expect(r.assignments.every((a) => a.channel !== "c1")).toBe(true);
  });

  it("does not write any config files", async () => {
    const userLayer: ConfigLayer = {};
    const answer = JSON.stringify({ assignments: [{ role: "tester", channel: "c1", model: "m1" }] });
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m1"}]}'] }, { body: chatReply(answer) }]);
    const core = new Core({
      fetcher,
      defaults,
      userConfig: memStore(userLayer),
      projectConfig: async () => memStore(),
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("setup.recommend", { projectId: "p" });
    expect(Object.keys(userLayer)).toHaveLength(0);
  });
});

describe("setup.recommend session qualification overlay", () => {
  const wizStore = () =>
    memStore({ "channels.yaml": "version: 1\nitems:\n  - id: w1\n    type: ollama\n    baseUrl: http://woll\n" });

  it("recommends from unapproved session records and leaves config untouched", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m1"}]}'] }]);
    const core = new Core({ fetcher, defaults: {}, userConfig: wizStore(), projectConfig: async () => memStore(), emitEvent: () => {} });
    await core.attachProject("p", fakeHost().host);
    core.qualRecords.set("w1", new Map([["m1", { agent: { passed: true, at: 1, version: 2, context: 32000 } }]]));
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as {
      ok: boolean;
      assignments: { channel: string; model: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.assignments.length).toBeGreaterThan(0);
    expect(r.assignments.every((a) => a.channel === "w1" && a.model === "m1")).toBe(true);
    const ch = core.ctx("p").config.channels.find((c) => c.id === "w1")!;
    expect(ch.modelCaps.m1?.qualified).toBeUndefined();
  });

  it("a failed session record refuses the roles", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m1"}]}'] }]);
    const core = new Core({ fetcher, defaults: {}, userConfig: wizStore(), projectConfig: async () => memStore(), emitEvent: () => {} });
    await core.attachProject("p", fakeHost().host);
    core.qualRecords.set("w1", new Map([["m1", { agent: { passed: false, at: 1, version: 2 } }]]));
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as {
      ok: boolean;
      unfilled: { role: string; reason: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.unfilled.length).toBeGreaterThan(0);
    expect(r.unfilled.map((u) => u.reason).join(" ")).toContain("failed agent qualification");
  });

  it("no session and no config records leaves every agent role unfilled", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m1"}]}'] }]);
    const core = new Core({ fetcher, defaults: {}, userConfig: wizStore(), projectConfig: async () => memStore(), emitEvent: () => {} });
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as {
      ok: boolean;
      unfilled: { role: string; reason: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.unfilled.length).toBeGreaterThan(0);
    expect(r.unfilled.map((u) => u.reason).join(" ")).toContain("not qualified as agent");
  });

  it("withSessionQualified keeps a config record the session left undefined", async () => {
    const { core } = mk([]);
    await core.attachProject("p", fakeHost().host);
    core.qualRecords.set("c1", new Map([["m1", { agent: undefined, function: { passed: true, at: 2, version: 2 } }]]));
    const cfg = core.ctx("p").config;
    const out = withSessionQualified(core, cfg);
    const q = out.channels.find((c) => c.id === "c1")!.modelCaps.m1!.qualified!;
    expect(q.agent?.passed).toBe(true);
    expect(q.function?.passed).toBe(true);
    expect(cfg.channels.find((c) => c.id === "c1")!.modelCaps.m1!.qualified!.function).toBeUndefined();
  });
});

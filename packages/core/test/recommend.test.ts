import { describe, expect, it } from "vitest";
import { Core } from "../src/core.js";
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

import { describe, expect, it } from "vitest";
import { Core } from "../src/core.js";
import { fakeFetcher, fakeHost } from "@stewart/kernel";

describe("setup.recommend modes", () => {
  const defaults = {
    "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    modelCaps: { m1: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } }, m2: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } }, 'qwen3:32b': { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } }, 'gemma4:e4b': { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } } }\n",
    "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
  };
  const mem = () => ({ read: async () => ({}), write: async () => {} });
  const mk = (responses: { status?: number; body?: string | string[] }[]) => {
    const { fetcher, calls } = fakeFetcher(responses);
    return { calls, core: new Core({ fetcher, defaults, userConfig: mem(), projectConfig: async () => mem(), emitEvent: () => {} }) };
  };

  it("rules mode makes no model call and returns scored assignments", async () => {
    const { core, calls } = mk([{ body: ['{"models":[{"name":"qwen3:32b"},{"name":"gemma4:e4b"}]}'] }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as {
      ok: boolean;
      assignments: { role: string; model: string; source: string; score: number }[];
      researcher?: unknown;
      unfilled: { role: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.researcher).toBeUndefined();
    expect(r.assignments.every((a) => a.source === "rules" && typeof a.score === "number")).toBe(true);
    expect(r.assignments.find((a) => a.role === "lead")?.model).toBe("qwen3:32b");
    expect(calls.map((x) => x.url)).toEqual(["http://oll/api/tags"]);
  });

  it("ai mode uses the chosen evaluator and rejects picks that fail hard requirements", async () => {
    const answer = JSON.stringify({ assignments: [{ role: "bogus-role", channel: "c1", model: "m2" }, { role: "lead", channel: "c1", model: "m2" }] });
    const { core } = mk([{ body: ['{"models":[{"name":"m1"},{"name":"m2"}]}'] }, { body: ['{"message":{"content":' + JSON.stringify(answer) + '},"done":false}', '{"done":true}'] }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "ai", evaluator: { channel: "c1", model: "m2" } })) as {
      ok: boolean;
      assignments: { role: string }[];
      researcher: { model: string };
      dropped: string[];
    };
    expect(r.researcher.model).toBe("m2");
    expect(r.assignments.map((a) => a.role)).toEqual(["lead"]);
    expect(r.dropped.join()).toContain("bogus-role");
  });

  it("ignores an evaluator that was not discovered", async () => {
    const { core } = mk([{ body: ['{"models":[{"name":"m1"}]}'] }, { body: ['{"message":{"content":"{}"},"done":false}', '{"done":true}'] }]);
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", evaluator: { channel: "zz", model: "nope" } })) as { researcher?: { model: string }; ok: boolean };
    expect(r.ok).toBe(false);
  });
});

import { agentSchema } from "@stewart/config";

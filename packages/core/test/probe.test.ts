import { describe, expect, it, vi } from "vitest";
import { Core } from "../src/core.js";
import { fakeFetcher, fakeHost } from "@stewart/kernel";
import type { ConfigLayer, ConfigStore } from "@stewart/config";
import type { Fetcher } from "@stewart/kernel";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}

const defaults = {
  "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n  - id: c2\n    type: openai-compatible\n    baseUrl: http://api\n",
  "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
};

const ollamaOk = ['{"message":{"content":"OK"},"done":false}', '{"done":true}'];
const sseOk = ['data: {"choices":[{"delta":{"content":"OK"}}]}', "data: [DONE]"];

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

type Snap = {
  status: string;
  ranking: boolean;
  items: { channel: string; model: string; state: string; reason?: string }[];
  green: { channel: string; model: string }[];
};

describe("setup.probe", () => {
  it("probes ollama before openai-compatible, marks red on HTTP error, and recommend uses only green", async () => {
    const { core, calls } = mk([
      { body: ollamaOk }, // smoke c1:m1
      { status: 500, body: "boom" }, // smoke c1:m2 → red
      { body: sseOk }, // smoke c2:r1
      { body: ['{"models":[{"name":"m1"},{"name":"m2"}]}'] }, // recommend: c1 listModels
      { body: ['{"data":[{"id":"r1"}]}'] }, // recommend: c2 listModels (rules mode: no chat)
    ]);
    await core.attachProject("p", fakeHost().host);
    const start = (await core.dispatch("setup.probe.start", {
      projectId: "p",
      candidates: [
        { channel: "c2", model: "r1" },
        { channel: "c1", model: "m2" },
        { channel: "c1", model: "m1" },
      ],
    })) as Snap;
    expect(start.status).toBe("running");
    await vi.waitFor(async () => {
      expect(((await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap).status).toBe("done");
    });
    const snap = (await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap;
    expect(snap.items.map((i) => `${i.channel}:${i.model}`)).toEqual(["c1:m1", "c1:m2", "c2:r1"]);
    expect(snap.items.map((i) => i.state)).toEqual(["green", "red", "green"]);
    expect(snap.green).toEqual([
      { channel: "c1", model: "m1" },
      { channel: "c2", model: "r1" },
    ]);
    // smoke calls went to /api/chat (ollama) before /chat/completions (openai)
    const chatCalls = calls.filter((c) => c.url.includes("/api/chat") || c.url.includes("/chat/completions"));
    expect(chatCalls.map((c) => c.url)).toEqual(["http://oll/api/chat", "http://oll/api/chat", "http://api/chat/completions"]);

    const rec = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as {
      ok: boolean;
      channels: { id: string; models: string[] }[];
      assignments: { channel: string; model: string }[];
    };
    expect(rec.ok).toBe(true);
    expect(rec.channels.find((c) => c.id === "c1")?.models).toEqual(["m1"]);
    expect(rec.channels.find((c) => c.id === "c2")?.models).toEqual(["r1"]);
    expect(rec.assignments.every((a) => a.model !== "m2")).toBe(true);
  });

  it("cancel stops the queue and marks unfinished candidates skipped", async () => {
    const { core } = mk([{ body: ollamaOk }, { body: ollamaOk }]);
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("setup.probe.start", {
      projectId: "p",
      candidates: [
        { channel: "c1", model: "m1" },
        { channel: "c1", model: "m2" },
      ],
    });
    await core.dispatch("setup.probe.cancel", { projectId: "p" });
    await vi.waitFor(async () => {
      expect(((await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap).status).not.toBe("running");
    });
    const snap = (await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap;
    expect(snap.status).toBe("cancelled");
    expect(snap.items.every((i) => i.state === "skipped" || i.state === "green")).toBe(true);
  });

  it("keeps probe queues isolated per project", async () => {
    const { core } = mk([ollamaOk, ollamaOk]);
    await core.attachProject("p1", fakeHost().host);
    await core.attachProject("p2", fakeHost().host);
    await core.dispatch("setup.probe.start", { projectId: "p1", candidates: [{ channel: "c1", model: "m1" }] });
    await core.dispatch("setup.probe.start", { projectId: "p2", candidates: [{ channel: "c1", model: "m2" }] });
    await vi.waitFor(async () => {
      expect(((await core.dispatch("setup.probe.status", { projectId: "p1" })) as Snap).status).toBe("done");
      expect(((await core.dispatch("setup.probe.status", { projectId: "p2" })) as Snap).status).toBe("done");
    });
    const s1 = (await core.dispatch("setup.probe.status", { projectId: "p1" })) as Snap;
    const s2 = (await core.dispatch("setup.probe.status", { projectId: "p2" })) as Snap;
    expect(s1.items.map((i) => i.model)).toEqual(["m1"]);
    expect(s2.items.map((i) => i.model)).toEqual(["m2"]);
    expect(s1.runId).toBe(1);
    expect(s2.runId).toBe(1);
  });

  it("reattach cancels the in-flight run and the next status is a fresh idle runner", async () => {
    const inner = fakeFetcher([ollamaOk]);
    const fetcher: Fetcher = async (url, init) => {
      const res = await inner.fetcher(url, init);
      if (url.includes("/api/chat")) await new Promise((r) => setTimeout(r, 80));
      return res;
    };
    const core = new Core({
      fetcher,
      defaults,
      userConfig: memStore(),
      projectConfig: async () => memStore(),
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    const started = (await core.dispatch("setup.probe.start", {
      projectId: "p",
      candidates: [{ channel: "c1", model: "m1" }],
    })) as Snap;
    expect(started.status).toBe("running");
    await core.attachProject("p", fakeHost().host);
    const snap = (await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap & { runId: number };
    expect(snap.status).toBe("idle");
    expect(snap.runId).toBe(0);
  });

  it("a changed candidate/evaluator fingerprint mid-run starts a new runId", async () => {
    const inner = fakeFetcher([ollamaOk, ollamaOk, ollamaOk]);
    const fetcher: Fetcher = async (url, init) => {
      const res = await inner.fetcher(url, init);
      if (url.includes("/api/chat")) await new Promise((r) => setTimeout(r, 60));
      return res;
    };
    const core = new Core({
      fetcher,
      defaults,
      userConfig: memStore(),
      projectConfig: async () => memStore(),
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    const s1 = (await core.dispatch("setup.probe.start", {
      projectId: "p",
      candidates: [{ channel: "c1", model: "m1" }],
    })) as Snap & { runId: number };
    expect(s1.status).toBe("running");
    const s2 = (await core.dispatch("setup.probe.start", {
      projectId: "p",
      candidates: [
        { channel: "c1", model: "m1" },
        { channel: "c1", model: "m2" },
      ],
      evaluator: { channel: "c1", model: "m1" },
    })) as Snap & { runId: number };
    expect(s2.runId).toBe(2);
    await vi.waitFor(async () => {
      expect(((await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap).status).toBe("done");
    });
    const snap = (await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap;
    expect(snap.items).toHaveLength(2);
    expect(snap.runId).toBe(2);
  });

  it("red reasons are normalized: provider bodies and secrets never reach the snapshot", async () => {
    const { core } = mk([
      { body: ollamaOk }, // c1:m1 smoke → green
      { status: 500, body: "Bearer supersecret-token-value {\"error\":\"x\"}" }, // c2:r1 smoke → red
    ]);
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("setup.probe.start", {
      projectId: "p",
      candidates: [
        { channel: "c2", model: "r1" },
        { channel: "c1", model: "m1" },
      ],
    });
    await vi.waitFor(async () => {
      expect(((await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap).status).toBe("done");
    });
    const snap = (await core.dispatch("setup.probe.status", { projectId: "p" })) as Snap;
    const bad = snap.items.find((i) => i.state === "red");
    expect(bad?.reason).toBe("POST /chat/completions → 500");
    expect(JSON.stringify(snap)).not.toContain("supersecret");
  });
});

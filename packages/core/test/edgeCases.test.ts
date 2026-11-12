import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import { Core } from "../src/core.js";
import { fakeHost } from "@stewart/kernel";
import type { ChannelAdapter, ChatEvent } from "@stewart/channels";
import type { ConfigLayer, ConfigStore } from "@stewart/config";

void api;

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
    delete: async (file) => {
      delete layer[file];
    },
  };
}

const adapter: ChannelAdapter = {
  type: "fake",
  listModels: async () => ["m1"],
  probeCaps: async () => ({ tools: true }),
  priceList: async () => ({ m1: { inPerMTok: 1, outPerMTok: 2 } }),
  chat: async function* () {
    yield { kind: "text", text: "hi there" } as ChatEvent;
    yield { kind: "done", usage: { in: 1, out: 1 } } as ChatEvent;
  },
};

function mk(userLayer: ConfigLayer = {}, projectLayer: ConfigLayer = {}, defaults: ConfigLayer = {}) {
  const user = memStore(userLayer);
  const project = memStore(projectLayer);
  const uLayer = userLayer;
  const pLayer = projectLayer;
  const core = new Core({
    defaults: {
      "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: fake\n    enabled: true\n",
      "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
      "roles.yaml": "version: 1\nitems:\n  - id: lead\n    enabled: true\n    agent: a1\n    turnBudget: 40\n",
      ...defaults,
    },
    userConfig: user,
    projectConfig: async () => project,
    fetcher: async () => {
      throw new Error("no fetch");
    },
    emitEvent: () => {},
  });
  core.channels.register("fake", () => adapter);
  return { core, user, project, uLayer, pLayer };
}

const attach = (core: Core, trusted = true) => core.attachProject("p", fakeHost({}, { trusted }).host);

describe("hello", () => {
  it("negotiates a valid hello and rejects a bad one", async () => {
    const { core } = mk();
    const r = await core.dispatch("hello", { version: "hi", protocol: 1, capabilities: ["events"] });
    expect((r as { protocol: number }).protocol).toBeGreaterThan(0);
    await expect(core.dispatch("hello", {})).rejects.toThrow();
    await expect(core.dispatch("no.such.method", {})).rejects.toThrow();
  });
});

describe("channel.test / channel.probe", () => {
  it("tests configured and missing channels", async () => {
    const { core } = mk();
    await attach(core);
    expect(((await core.dispatch("channel.test", { projectId: "p", channelId: "c1" })) as { ok: boolean; models?: string[] }).models).toEqual(["m1"]);
    expect(((await core.dispatch("channel.test", { projectId: "p", channelId: "nope" })) as { ok: boolean }).ok).toBe(false);
  });

  it("probes caps, caches them and returns catalog info", async () => {
    const { core } = mk();
    await attach(core);
    const r1 = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m1" })) as { ok: boolean; cached: boolean; catalog?: { source: string } };
    expect(r1.ok).toBe(true);
    expect(r1.cached).toBe(false);
    expect(r1.catalog?.source).toBe("live");
    const r2 = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m1" })) as { cached: boolean };
    expect(r2.cached).toBe(true);
    const r3 = (await core.dispatch("channel.probe", { projectId: "p", channelId: "missing", model: "m1" })) as { ok: boolean };
    expect(r3.ok).toBe(false);
  });
});

describe("config handlers", () => {
  it("config.get returns merged files, summary and secrets", async () => {
    const { core } = mk();
    await attach(core);
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { files: ConfigLayer; summary: { channels: unknown[] }; secrets: Record<string, boolean> };
    expect(r.files["channels.yaml"]).toContain("c1");
    expect(r.summary.channels).toHaveLength(1);
  });

  it("config.set validates file, yaml and schema then writes", async () => {
    const { core, uLayer } = mk();
    await attach(core);
    await expect(core.dispatch("config.set", { projectId: "p", file: "bogus.yaml", yaml: "x" })).rejects.toThrow("unknown config file");
    await expect(core.dispatch("config.set", { projectId: "p", file: "roles.yaml", yaml: "version: 1\nitems: [\n" })).rejects.toThrow();
    await expect(core.dispatch("config.set", { projectId: "p", file: "roles.yaml", yaml: "version: 1\nitems: \"nope\"\n" })).rejects.toThrow("invalid roles.yaml");
    expect(((await core.dispatch("config.set", { projectId: "p", file: "settings.yaml", yaml: "version: 1\n" })) as { ok: boolean }).ok).toBe(true);
    expect(((await core.dispatch("config.set", { projectId: "p", file: "roles.yaml", yaml: "version: 1\nitems: []\n", layer: "project" })) as { ok: boolean }).ok).toBe(true);
    expect(uLayer["settings.yaml"]).toBe("version: 1\n");
    await expect(core.dispatch("config.set", { projectId: "p", file: "secrets.yaml", yaml: "version: 1\n", layer: "project" })).rejects.toThrow();
  });

  it("config.set project layer requires a trusted workspace", async () => {
    const { core } = mk();
    await attach(core, false);
    await expect(core.dispatch("config.set", { projectId: "p", file: "roles.yaml", yaml: "version: 1\nitems: []\n", layer: "project" })).rejects.toThrow("trusted");
  });

  it("skills.save/reset and roles.reset/assign round-trip through layers", async () => {
    const { core, uLayer } = mk({ "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n" });
    await attach(core);
    expect(((await core.dispatch("skills.save", { projectId: "p", id: "s1", body: "do x" })) as { ok: boolean }).ok).toBe(true);
    expect(uLayer["skills/s1.md"]).toContain("do x");
    await expect(core.dispatch("skills.save", { projectId: "p", id: "s1", body: "b", layer: "project" })).toBeTruthy();
    expect(((await core.dispatch("skills.reset", { projectId: "p", id: "s1" })) as { ok: boolean }).ok).toBe(true);
    expect(uLayer["skills/s1.md"]).toBeUndefined();
    await expect(core.dispatch("roles.assignAgent", { projectId: "p", agentId: "gone" })).rejects.toThrow("unknown agent");
    expect(((await core.dispatch("roles.assignAgent", { projectId: "p", agentId: "a1" })) as { ok: boolean }).ok).toBe(true);
    expect(((await core.dispatch("roles.reset", { projectId: "p", roleId: "general-worker" })) as { ok: boolean }).ok).toBe(true);
    expect(((await core.dispatch("roles.reset", { projectId: "p" })) as { ok: boolean }).ok).toBe(true);
  });
});

describe("chat handlers", () => {
  it("chat.send starts a lead session and cancel/answer/approve/history handlers respond", async () => {
    const { core } = mk();
    await attach(core);
    const r = (await core.dispatch("chat.send", { projectId: "p", text: "hi" })) as { runId: string };
    expect(r.runId).toBeTruthy();
    expect(((await core.dispatch("chat.cancel", { projectId: "p", runId: r.runId })) as { ok: boolean }).ok).toBeDefined();
    expect(((await core.dispatch("chat.answer", { projectId: "p", questionId: "q", answer: "a" })) as { ok: boolean }).ok).toBe(false);
    expect(((await core.dispatch("chat.approve", { projectId: "p", approvalId: "a", grant: "once" })) as { ok: boolean }).ok).toBe(false);
    expect(((await core.dispatch("history.load", { projectId: "p", sessionId: "none" })) as { messages: unknown[] }).messages).toEqual([]);
    expect(((await core.dispatch("history.delete", { projectId: "p", sessionId: "none" })) as { ok: boolean }).ok).toBe(true);
  });
});

describe("setup.recommend via dispatch", () => {
  it("rules mode works without a model call", async () => {
    const { core } = mk();
    await attach(core);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it("persists priorities and typical work from context", async () => {
    const { core, uLayer } = mk();
    await attach(core);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules", context: { priorities: { speed: 3, cost: 1, quality: 2 }, typicalWork: "features" } })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(JSON.stringify(uLayer)).toContain("setupPriorities");
    expect(JSON.stringify(uLayer)).toContain("features");
  });

  it("clamps out-of-range priorities to 2, keeps 1/3, writes nothing without context, and falls back to stored settings", async () => {
    const { core, uLayer } = mk();
    await attach(core);
    const r = (await core.dispatch("setup.recommend", { projectId: "p", mode: "rules", context: { priorities: { speed: 9, cost: 1, quality: 3 } } })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const yaml = uLayer["settings.yaml"] ?? "";
    expect(yaml).toContain("speed: 2");
    expect(yaml).toContain("cost: 1");
    expect(yaml).toContain("quality: 3");

    const quiet = mk();
    await attach(quiet.core);
    const r2 = (await quiet.core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as { ok: boolean };
    expect(r2.ok).toBe(true);
    expect(quiet.uLayer["settings.yaml"]).toBeUndefined();

    const seeded = mk({ "settings.yaml": "version: 1\nsetupPriorities: { speed: 1, cost: 3, quality: 2 }\nsetupTypicalWork: refactors\n" });
    await attach(seeded.core);
    const r3 = (await seeded.core.dispatch("setup.recommend", { projectId: "p", mode: "rules" })) as { ok: boolean };
    expect(r3.ok).toBe(true);
    expect(seeded.uLayer["settings.yaml"]).toBe("version: 1\nsetupPriorities: { speed: 1, cost: 3, quality: 2 }\nsetupTypicalWork: refactors\n");
  });
});

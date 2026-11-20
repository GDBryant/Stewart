import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { fakeHost } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import type { ConfigLayer, ConfigStore } from "@stewart/config";
import { Core } from "../src/core.js";

function memStore(layer: ConfigLayer = {}): { store: ConfigStore; layer: ConfigLayer } {
  return {
    layer,
    store: {
      read: async () => ({ ...layer }),
      write: async (file, yaml) => {
        layer[file] = yaml;
      },
    },
  };
}

const CHANNELS_YAML = `version: 1
items:
  - id: c1
    type: ollama
    enabled: true
  - id: c2
    type: ollama
    enabled: true
`;
const AGENTS_YAML = `version: 1
items:
  - id: a1
    channel: c1
    model: m1
  - id: a2
    channel: c2
    model: m9
`;
const ROLES_YAML = `version: 1
items:
  - id: lead
    enabled: true
    agent: a1
  - id: helper
    enabled: true
    agent: a2
`;

const mc = (id: string, impl: { list?: () => Promise<string[]>; failOnce?: boolean }): ManagedChannel => {
  let failed = false;
  return {
    cfg: { id, type: "ollama" },
    listModels: async () => {
      if (impl.failOnce && !failed) {
        failed = true;
        throw new Error("conn refused");
      }
      return impl.list ? impl.list() : Promise.reject(new Error("conn refused"));
    },
    priceList: async () => undefined,
  } as unknown as ManagedChannel;
};

interface Rig {
  core: Core;
  layer: ConfigLayer;
  questions: string[];
  answer: (answers: (string | "withdrawn")[]) => void;
}

async function rig(opts: { channels?: ConfigLayer; models?: Record<string, ManagedChannel> } = {}): Promise<Rig> {
  const { store, layer } = memStore({
    "channels.yaml": CHANNELS_YAML,
    "agents.yaml": AGENTS_YAML,
    "roles.yaml": ROLES_YAML,
    ...(opts.channels ?? {}),
  });
  const core = new Core({
    fetcher: async () => {
      throw new Error("no fetch");
    },
    defaults: {},
    userConfig: store,
    projectConfig: async () => memStore().store,
    emitEvent: () => {},
  });
  await core.attachProject("p", fakeHost().host);
  const managed = opts.models ?? { c1: mc("c1", { list: async () => ["m1"] }), c2: mc("c2", {}) };
  vi.spyOn(core.channelService, "get").mockImplementation((id: string) => managed[id]);
  const ctx = core.ctx("p");
  const questions: string[] = [];
  let answers: (string | "withdrawn")[] = [];
  vi.spyOn(ctx.interaction, "ask").mockImplementation(async (prompt) => {
    questions.push(prompt.kind === "question" ? prompt.question : "?");
    const next = answers.shift();
    return next === undefined || next === "withdrawn" ? { kind: "withdrawn" as const, reason: "cancel" as const } : { kind: "answered" as const, value: next };
  });
  return { core, layer, questions, answer: (a) => (answers = a) };
}

const itemsOf = (layer: ConfigLayer, file: string): Record<string, unknown>[] => ((parseYaml(layer[file] ?? "") as { items?: Record<string, unknown>[] } | null)?.items ?? []);
const refresh = (core: Core) => core.dispatch("models.refresh", { projectId: "p" }) as Promise<{ ok: boolean; error?: string; added?: string[]; removed?: string[]; unreachable?: string[] }>;

describe("models.refresh", () => {
  it("registers an agent for a new model on confirmation", async () => {
    const r = await rig({ models: { c1: mc("c1", { list: async () => ["m1", "m2"] }), c2: mc("c2", {}) } });
    r.answer(["Keep", "Add"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, added: ["c1-m2"], unreachable: ["c2"] });
    const agents = itemsOf(r.layer, "agents.yaml");
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2", "c1-m2"]);
    expect(agents[2]).toMatchObject({ channel: "c1", model: "m2", billing: "free" });
    expect(itemsOf(r.layer, "roles.yaml").find((x) => x.id === "lead")).toMatchObject({ agent: "a1" });
  });

  it("writes nothing when the user keeps everything and no diff exists", async () => {
    const r = await rig();
    r.answer(["Keep"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, added: [], removed: [], unreachable: ["c2"] });
    expect(r.layer["agents.yaml"]).toBe(AGENTS_YAML);
    expect(r.layer["channels.yaml"]).toBe(CHANNELS_YAML);
    expect(r.layer["roles.yaml"]).toBe(ROLES_YAML);
  });

  it("removes a channel and its bound agents, unbinding roles", async () => {
    const r = await rig();
    r.answer(["Remove channel + 1 agent"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, removedChannels: ["c2"], removed: ["a2"] });
    expect(itemsOf(r.layer, "channels.yaml").map((c) => c.id)).toEqual(["c1"]);
    expect(itemsOf(r.layer, "agents.yaml").map((a) => a.id)).toEqual(["a1"]);
    const helper = itemsOf(r.layer, "roles.yaml").find((x) => x.id === "helper")!;
    expect(helper.agent).toBeUndefined();
    expect(itemsOf(r.layer, "roles.yaml").find((x) => x.id === "lead")).toMatchObject({ agent: "a1" });
  });

  it("disables a channel without touching its agents", async () => {
    const r = await rig();
    r.answer(["Disable channel"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, disabledChannels: ["c2"], removed: [] });
    expect(itemsOf(r.layer, "channels.yaml")).toEqual([
      { id: "c1", type: "ollama", enabled: true },
      { id: "c2", type: "ollama", enabled: false },
    ]);
    expect(r.layer["agents.yaml"]).toBe(AGENTS_YAML);
  });

  it("retry once joins the normal diff when the channel answers", async () => {
    const r = await rig({ models: { c1: mc("c1", { list: async () => ["m1"] }), c2: mc("c2", { failOnce: true, list: async () => ["m9"] }) } });
    r.answer(["Retry once"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, added: [], removed: [], unreachable: [] });
    expect(r.layer["agents.yaml"]).toBe(AGENTS_YAML);
  });

  it("removes a gone-model agent on confirmation and unbinds its roles", async () => {
    const r = await rig({ models: { c1: mc("c1", { list: async () => ["m3"] }), c2: mc("c2", {}) } });
    r.answer(["Keep", "Skip", "Remove agent"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, removed: ["a1"] });
    expect(itemsOf(r.layer, "agents.yaml").map((a) => a.id)).toEqual(["a2"]);
    const lead = itemsOf(r.layer, "roles.yaml").find((x) => x.id === "lead")!;
    expect(lead.agent).toBeUndefined();
    expect(r.questions.some((q) => q.includes("lead"))).toBe(true);
  });

  it("adds all new agents without per-model questions on Add all", async () => {
    const r = await rig({ models: { c1: mc("c1", { list: async () => ["m1", "m2", "m3"] }), c2: mc("c2", {}) } });
    r.answer(["Keep", "Add all"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true });
    expect((res.added ?? []).sort()).toEqual(["c1-m2", "c1-m3"]);
    expect(r.questions.filter((q) => q.includes("Register an agent"))).toHaveLength(0);
  });

  it("treats withdrawn prompts as keep and writes nothing", async () => {
    const r = await rig({ models: { c1: mc("c1", { list: async () => ["m1", "m2"] }), c2: mc("c2", {}) } });
    r.answer(["withdrawn", "withdrawn"]);
    const res = await refresh(r.core);
    expect(res).toMatchObject({ ok: true, added: [], removed: [] });
    expect(r.layer["agents.yaml"]).toBe(AGENTS_YAML);
  });

  it("rejects a second refresh while one is in flight", async () => {
    const r = await rig();
    const pending: ((v: unknown) => void)[] = [];
    vi.spyOn(r.core.ctx("p").interaction, "ask").mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const first = refresh(r.core);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = await refresh(r.core);
    expect(second).toMatchObject({ ok: false, error: "models refresh already running" });
    pending[0]({ kind: "withdrawn", reason: "cancel" });
    await first;
  });
});

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { fakeHost } from "@stewart/kernel";
import { fakeFetcher } from "@stewart/kernel";
import type { ConfigLayer, ConfigStore } from "@stewart/config";
import { Core } from "../src/core.js";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}

const itemsOf = (layer: ConfigLayer, file: string): Record<string, unknown>[] =>
  ((parseYaml(layer[file] ?? "") as { items?: Record<string, unknown>[] })?.items ?? []);

interface Rig {
  core: Core;
  userLayer: ConfigLayer;
  projectLayer: ConfigLayer;
}

async function rig(opts: { user?: ConfigLayer; project?: ConfigLayer; trusted?: boolean } = {}): Promise<Rig> {
  const userLayer = opts.user ?? {};
  const projectLayer = opts.project ?? {};
  const core = new Core({
    defaults: {},
    userConfig: memStore(userLayer),
    projectConfig: async () => memStore(projectLayer),
    fetcher: fakeFetcher([]).fetcher,
    emitEvent: () => {},
  });
  await core.attachProject("p", fakeHost(undefined, { trusted: opts.trusted ?? true }).host);
  return { core, userLayer, projectLayer };
}

const set = (core: Core, file: string, yaml: string, layer?: "user" | "project") =>
  core.dispatch("config.set", { projectId: "p", file, yaml, layer });
const get = (core: Core) =>
  core.dispatch("config.get", { projectId: "p" }) as Promise<{
    summary: { agents: { id: string }[]; roles: { id: string; agent?: string }[]; errors?: string[] };
  }>;

const FULL: ConfigLayer = {
  "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n  - id: c2\n    type: ollama\n",
  "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n  - id: a2\n    channel: c2\n    model: m\n",
  "roles.yaml": "version: 1\nitems:\n  - id: lead\n    enabled: true\n    agent: a2\n    secondary: a1\n  - id: helper\n    enabled: true\n    agent: a1\n",
};

describe("config.set removal cascade", () => {
  it("channels.yaml minus a channel drops its agents and resets bound roles", async () => {
    const r = await rig({ user: { ...FULL } });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n");
    expect(itemsOf(r.userLayer, "agents.yaml").map((a) => a.id)).toEqual(["a1"]);
    const roles = itemsOf(r.userLayer, "roles.yaml");
    expect(roles.find((x) => x.id === "lead")).toEqual({ id: "lead", enabled: true, agent: "a1" }); // secondary promoted
    const res = await get(r.core);
    expect(res.summary.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(res.summary.errors ?? []).toEqual([]);
  });

  it("agents.yaml minus an agent resets bound roles and does not rewrite agents.yaml", async () => {
    const r = await rig({ user: { ...FULL } });
    const yaml = "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n";
    await set(r.core, "agents.yaml", yaml);
    const roles = itemsOf(r.userLayer, "roles.yaml");
    expect(roles.find((x) => x.id === "lead")).toEqual({ id: "lead", enabled: true, agent: "a1" }); // secondary promoted
    expect(roles.find((x) => x.id === "helper")).toEqual({ id: "helper", enabled: true, agent: "a1" });
    // The file itself holds exactly what the caller wrote — the cascade only fixes roles.
    expect(r.userLayer["agents.yaml"]).toBe(yaml);
    expect(itemsOf(r.userLayer, "agents.yaml").map((a) => a.id)).toEqual(["a1"]);
  });

  it("a field edit with no removed id leaves the other files byte-identical", async () => {
    const r = await rig({ user: { ...FULL } });
    const agents = r.userLayer["agents.yaml"];
    const roles = r.userLayer["roles.yaml"];
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n  - id: c2\n    type: ollama\n    enabled: false\n");
    expect(r.userLayer["agents.yaml"]).toBe(agents);
    expect(r.userLayer["roles.yaml"]).toBe(roles);
  });

  it("a channel id rename re-points its agents instead of removing them", async () => {
    const r = await rig({ user: { ...FULL } });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n  - id: c3\n    type: ollama\n");
    const agents = itemsOf(r.userLayer, "agents.yaml");
    expect(agents).toEqual([
      { id: "a1", channel: "c1", model: "m" },
      { id: "a2", channel: "c3", model: "m" },
    ]);
    expect(r.userLayer["roles.yaml"]).toBe(FULL["roles.yaml"]); // roles unaffected
  });

  it("a rename onto an existing channel id merges its agents instead of removing them", async () => {
    const r = await rig({ user: { ...FULL } });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n  - id: c1\n    type: ollama\n");
    expect(itemsOf(r.userLayer, "agents.yaml")).toEqual([
      { id: "a1", channel: "c1", model: "m" },
      { id: "a2", channel: "c1", model: "m" },
    ]);
    expect(r.userLayer["roles.yaml"]).toBe(FULL["roles.yaml"]); // roles unaffected
  });

  it("an unparseable user roles.yaml is left alone while the cascade still runs", async () => {
    const broken = "items: [\n";
    const r = await rig({ user: { ...FULL, "roles.yaml": broken } });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n");
    expect(itemsOf(r.userLayer, "agents.yaml").map((a) => a.id)).toEqual(["a1"]);
    expect(r.userLayer["roles.yaml"]).toBe(broken);
  });

  it("an agent id rename re-points role bindings", async () => {
    const r = await rig({ user: { ...FULL } });
    await set(
      r.core,
      "agents.yaml",
      "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n  - id: a9\n    channel: c2\n    model: m\n",
    );
    const roles = itemsOf(r.userLayer, "roles.yaml");
    expect(roles.find((x) => x.id === "lead")).toEqual({ id: "lead", enabled: true, agent: "a9", secondary: "a1" });
    expect(roles.find((x) => x.id === "helper")).toEqual({ id: "helper", enabled: true, agent: "a1" });
  });

  it("creates no roles.yaml when the user layer had none", async () => {
    const r = await rig({
      user: { "channels.yaml": FULL["channels.yaml"], "agents.yaml": FULL["agents.yaml"] },
    });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n");
    expect(itemsOf(r.userLayer, "agents.yaml").map((a) => a.id)).toEqual(["a1"]);
    expect(r.userLayer["roles.yaml"]).toBeUndefined(); // defaults are never materialized
  });

  it("resets bindings in a trusted project roles.yaml too", async () => {
    const r = await rig({
      user: { ...FULL },
      project: { "roles.yaml": "version: 1\nitems:\n  - id: proj\n    enabled: true\n    agent: a2\n" },
    });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n");
    const roles = itemsOf(r.projectLayer, "roles.yaml");
    expect(roles[0]).toEqual({ id: "proj", enabled: true });
  });

  it("leaves an untrusted project's roles.yaml untouched", async () => {
    const r = await rig({
      trusted: false,
      user: { ...FULL },
      project: { "roles.yaml": "version: 1\nitems:\n  - id: proj\n    enabled: true\n    agent: a2\n" },
    });
    await set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n");
    expect(itemsOf(r.projectLayer, "roles.yaml")[0]).toEqual({ id: "proj", enabled: true, agent: "a2" });
  });

  it("does not cascade for layer: project writes", async () => {
    const r = await rig({
      user: { ...FULL },
      project: { "roles.yaml": "version: 1\nitems:\n  - id: proj\n    enabled: true\n    agent: a2\n" },
    });
    await set(r.core, "roles.yaml", "version: 1\nitems:\n  - id: other\n    enabled: true\n", "project");
    // agents.yaml untouched — project-layer roles edits never trigger the user cascade.
    expect(r.userLayer["agents.yaml"]).toBe(FULL["agents.yaml"]);
  });

  it("still reloads when a cascade write fails", async () => {
    const r = await rig({ user: { ...FULL } });
    const store = r.core.deps.userConfig;
    const origWrite = store.write.bind(store);
    let failOnce = true;
    store.write = async (file: string, yaml: string) => {
      if (file === "roles.yaml" && failOnce) {
        failOnce = false;
        throw new Error("disk full");
      }
      return origWrite(file, yaml);
    };
    await expect(set(r.core, "channels.yaml", "version: 1\nitems:\n  - id: c1\n    type: ollama\n")).rejects.toThrow("disk full");
    const res = await get(r.core); // finally-block reload ran
    expect(res.summary.agents.map((a) => a.id)).toEqual(["a1"]);
  });
});

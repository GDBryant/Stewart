import { describe, expect, it, vi } from "vitest";
import { matchGlob } from "@stewart/roles-skills";
import { projectTools } from "@stewart/tools";
import { ProjectPaths } from "@stewart/tools";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { fakeHost } from "@stewart/kernel";
import type { RoleDef } from "@stewart/config";
import { Core } from "../src/core.js";
import { fakeFetcher } from "@stewart/kernel";
import type { ConfigStore } from "@stewart/config";
import type { ConfigLayer } from "@stewart/config";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_ROLES_YAML } from "@stewart/roles-skills";
import { DEFAULT_SKILLS } from "@stewart/roles-skills";
import { loadEffectiveConfig } from "@stewart/roles-skills";
import type { RunEvent } from "@stewart/protocol";

const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 25, ...over,
});

describe("Core roles + skills dispatch", () => {
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

  const defaults = {
    "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    modelCaps:\n      m:\n        qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } }\n",
    "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
  };

  function mk(userLayer: ConfigLayer = {}) {
    const events: RunEvent[] = [];
    const layer = userLayer;
    const core = new Core({
      defaults,
      userConfig: memStore(layer),
      projectConfig: async () => memStore(),
      fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher,
      emitEvent: (e) => events.push(e),
    });
    return { core, layer, events };
  }

  it("an empty roster is valid: no roles load, shipped skills still merge", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { id: string; enabled: boolean }[]; skills: { id: string; source: string }[] } };
    expect(r.summary.roles).toEqual([]);
    expect(r.summary.skills.map((s) => s.id)).toContain("tdd");
    expect(r.summary.skills.every((s) => s.source === "shipped")).toBe(true);
  });

  it("roles.addDefaults copies shipped rows verbatim: disabled and unbound", async () => {
    const { core, layer } = mk();
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("roles.addDefaults", { projectId: "p" })) as { added: string[] };
    expect(r.added.length).toBe(11);
    const saved = (parseYaml(layer["roles.yaml"]!) as { items: { id: string; enabled?: boolean; agent?: string }[] }).items;
    for (const row of saved) {
      expect(row.enabled, row.id).toBe(false);
      expect(row.agent, row.id).toBeUndefined();
    }
  });

  it("skills.save writes a user skill file with baseHash; skills.reset removes it", async () => {
    const { core, layer } = mk();
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("skills.save", { projectId: "p", id: "tdd", body: "my version" });
    expect(layer["skills/tdd.md"]).toContain("my version");
    expect(layer["skills/tdd.md"]).toContain("baseHash");
    let r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { skills: { id: string; source: string; edited: boolean }[] } };
    const tdd = r.summary.skills.find((s) => s.id === "tdd")!;
    expect(tdd).toMatchObject({ source: "user", edited: true });
    await core.dispatch("skills.reset", { projectId: "p", id: "tdd" });
    expect(layer["skills/tdd.md"]).toBeUndefined();
    r = (await core.dispatch("config.get", { projectId: "p" })) as typeof r;
    expect(r.summary.skills.find((s) => s.id === "tdd")!.source).toBe("shipped");
  });

  it("roles.reset removes the user override for one role or all", async () => {
    const { core, layer } = mk({
      "roles.yaml": "version: 1\nitems:\n  - id: lead\n    agent: a1\n    turnBudget: 3\n",
    });
    await core.attachProject("p", fakeHost().host);
    let r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { id: string; turnBudget: number }[] } };
    expect(r.summary.roles.find((x) => x.id === "lead")!.turnBudget).toBe(3);
    await core.dispatch("roles.reset", { projectId: "p", roleId: "lead" });
    r = (await core.dispatch("config.get", { projectId: "p" })) as typeof r;
    expect(r.summary.roles.find((x) => x.id === "lead")).toBeUndefined(); // shipped defaults no longer reappear
    await core.dispatch("roles.reset", { projectId: "p" });
    expect(layer["roles.yaml"]).toContain("items: []");
  });

  it("roles.addDefaults adds only the shipped roles missing from the user file and keeps custom rows", async () => {
    const { core, layer } = mk({
      "roles.yaml": "version: 1\nitems:\n  - id: mine\n    enabled: true\n    prompt: custom\n  - id: lead\n    turnBudget: 3\n",
    });
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("roles.addDefaults", { projectId: "p" })) as { ok: boolean; added: string[] };
    expect(r.added).toEqual(["explorer", "reviewer", "auditor", "tester", "planner", "interrogator", "spec-writer", "builder", "investigator", "documenter"]);
    const saved = (parseYaml(layer["roles.yaml"]!) as { items: { id: string; turnBudget?: number; prompt?: string }[] }).items;
    expect(saved.map((x) => x.id)).toEqual(["mine", "lead", ...r.added]);
    expect(saved.find((x) => x.id === "mine")!.prompt).toBe("custom");
    expect(saved.find((x) => x.id === "lead")!.turnBudget).toBe(3);
  });

  it("roles.addDefaults is a no-op write when nothing is missing", async () => {
    const { core, layer } = mk();
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("roles.addDefaults", { projectId: "p" });
    const before = layer["roles.yaml"];
    const r = (await core.dispatch("roles.addDefaults", { projectId: "p" })) as { added: string[] };
    expect(r.added).toEqual([]);
    expect(layer["roles.yaml"]).toBe(before);
  });

  it("roles.assignAgent sets agent on every role and validates the id", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost().host);
    await expect(core.dispatch("roles.assignAgent", { projectId: "p", agentId: "nope" })).rejects.toThrow(/unknown agent/);
    await core.dispatch("roles.assignAgent", { projectId: "p", agentId: "a1", wizard: true });
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { agent?: string }[] } };
    expect(r.summary.roles.length).toBe(11);
    expect(r.summary.roles.every((x) => x.agent === "a1")).toBe(true);
  });

  it("roles.assignAgent removes legacy chain and drops a secondary equal to the new agent", async () => {
    const userLayer: ConfigLayer = {
      "roles.yaml": "version: 1\nitems:\n  - id: lead\n    enabled: true\n    agent: old\n    chain: [old, a1]\n  - id: reviewer\n    enabled: true\n    agent: old\n    secondary: keep\n    chain: [old]\n",
    };
    const { core, layer } = mk(userLayer);
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("roles.assignAgent", { projectId: "p", agentId: "a1" });
    const doc = parseYaml(layer["roles.yaml"]!) as { items: Record<string, unknown>[] };
    const lead = doc.items.find((i) => i.id === "lead")!;
    const reviewer = doc.items.find((i) => i.id === "reviewer")!;
    expect("chain" in lead).toBe(false);
    expect(lead.secondary).toBeUndefined();
    expect("chain" in reviewer).toBe(false);
    expect(reviewer.secondary).toBe("keep");
  });

  it("roles.assignAgent refuses an agent that is not qualified for the lead", async () => {
    const core = new Core({
      defaults: { ...defaults, "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n" },
      userConfig: memStore(),
      projectConfig: async () => memStore(),
      fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    await expect(core.dispatch("roles.assignAgent", { projectId: "p", agentId: "a1", wizard: true })).rejects.toThrow(/cannot serve lead: not qualified as agent/);
  });

  it("roles.assignAgent with wizard enables only the lead role", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost().host);
    await core.dispatch("roles.assignAgent", { projectId: "p", agentId: "a1", wizard: true });
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { id: string; enabled: boolean }[] } };
    expect(r.summary.roles.filter((x) => x.enabled).map((x) => x.id)).toEqual(["lead"]);
  });

  it("chat.send runs the lead role: prompt + filtered tools", async () => {
    const bodies: string[] = [];
    const fetcher = async (_u: string, init: { body?: string }) => {
      bodies.push(init.body ?? "");
      return { status: 200, headers: {}, body: null };
    };
    const events: RunEvent[] = [];
    const core = new Core({
      defaults,
      userConfig: memStore({
        "roles.yaml": "version: 1\nitems:\n  - id: lead\n    enabled: true\n    agent: a1\n    prompt: You are Stewart, a coding assistant.\n    tools: [ReadFile, WriteFile]\n    turnBudget: 1\n",
      }),
      projectConfig: async () => memStore(),
      fetcher,
      emitEvent: (e) => events.push(e),
    });
    await core.attachProject("p", fakeHost().host);
    // ollama returns null body → chat will fail, but we only need the outbound request.
    try {
      await core.dispatch("chat.send", { projectId: "p", text: "hi" });
    } catch {
      /* run fails after request is made */
    }
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const sent = JSON.parse(bodies[0]) as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("You are Stewart");
    expect(sent.messages[1].content).toBe("hi");
    const names = (sent.tools ?? []).map((t) => t.function.name);
    expect(names).toContain("ReadFile");
    expect(names).not.toContain("RunTerminal");
  });

  it("chat.send fails when the lead role is disabled", async () => {
    const core = new Core({
      defaults,
      userConfig: memStore({ "roles.yaml": "version: 1\nitems:\n  - id: lead\n    enabled: false\n" }),
      projectConfig: async () => memStore(),
      fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    await expect(core.dispatch("chat.send", { projectId: "p", text: "hi" })).rejects.toThrow(/no enabled agent-kind role/);
  });

  it("surfaces unknown bound agents as config errors", async () => {
    const { core } = mk({ "roles.yaml": "version: 1\nitems:\n  - id: planner\n    enabled: true\n    agent: nope\n" });
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { errors: string[] };
    expect(r.errors).toContain("role planner: unknown agent 'nope'");
  });

  it("chat.send falls back to the first agent when lead has no binding", async () => {
    const bodies: string[] = [];
    const fetcher = async (_u: string, init: { body?: string }) => {
      bodies.push(init.body ?? "");
      return { status: 200, headers: {}, body: null };
    };
    const core = new Core({
      defaults,
      userConfig: memStore({ "roles.yaml": "version: 1\nitems:\n  - id: lead\n    enabled: true\n    prompt: You are Stewart, a coding assistant.\n" }),
      projectConfig: async () => memStore(),
      fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    try {
      await core.dispatch("chat.send", { projectId: "p", text: "hi" });
    } catch {
      /* run fails after request is made */
    }
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const sent = JSON.parse(bodies[0]) as { messages: { role: string; content: string }[] };
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("You are Stewart");
    expect(sent.messages[1]).toMatchObject({ role: "user", content: "hi" });
  });
});

describe("shipped lead role", () => {
  const shipped = () => (parseYaml(DEFAULT_ROLES_YAML) as { items: RoleDef[] }).items;
  it("ships lead first, all disabled", () => {
    const roles = shipped();
    expect(roles.map((r) => r.id)).toEqual(["lead", "explorer", "reviewer", "auditor", "tester", "planner", "interrogator", "spec-writer", "builder", "investigator", "documenter"]);
    expect(roles[0].enabled).toBe(false);
  });
  it("every shipped role references only shipped skills", () => {
    const ids = new Set(DEFAULT_SKILLS.map((s) => s.id));
    for (const x of shipped()) for (const s of x.skills) expect(ids.has(s), `${x.id}:${s}`).toBe(true);
  });
  it("user roles.yaml with old role ids loads them as inert profiles; shipped rows never merge in", () => {
    const user = stringifyYaml({ version: 1, items: [{ id: "orchestrator", enabled: false }, { id: "general-worker", enabled: false }] });
    const cfg = loadEffectiveConfig({ "roles.yaml": user }, undefined, { "roles.yaml": DEFAULT_ROLES_YAML }, { trusted: true });
    const ids = cfg.roles.map((x) => x.id).sort();
    expect(ids).toEqual(["general-worker", "orchestrator"]);
    expect(cfg.errors).toEqual([]);
  });
});

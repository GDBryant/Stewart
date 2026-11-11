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
import { isWriteCapableRole } from "@stewart/roles-skills";
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
    "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n",
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

  it("shipped defaults provide the full role set and skills", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { id: string }[]; skills: { id: string; source: string }[] } };
    const ids = r.summary.roles.map((x) => x.id);
    for (const id of ["orchestrator", "planner", "general-worker", "code-writer", "image-reader"]) expect(ids).toContain(id);
    expect(r.summary.skills.map((s) => s.id)).toContain("execution-contract");
    expect(r.summary.skills.every((s) => s.source === "shipped")).toBe(true);
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
      "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    agent: a1\n    turnBudget: 3\n  - id: planner\n    enabled: true\n",
    });
    await core.attachProject("p", fakeHost().host);
    let r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { id: string; turnBudget: number }[] } };
    expect(r.summary.roles.find((x) => x.id === "general-worker")!.turnBudget).toBe(3);
    await core.dispatch("roles.reset", { projectId: "p", roleId: "general-worker" });
    r = (await core.dispatch("config.get", { projectId: "p" })) as typeof r;
    expect(r.summary.roles.find((x) => x.id === "general-worker")!.turnBudget).toBe(25); // shipped default
    await core.dispatch("roles.reset", { projectId: "p" });
    expect(layer["roles.yaml"]).toContain("items: []");
  });

  it("roles.assignAgent sets agent on every role and validates the id", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost().host);
    await expect(core.dispatch("roles.assignAgent", { projectId: "p", agentId: "nope" })).rejects.toThrow(/unknown agent/);
    await core.dispatch("roles.assignAgent", { projectId: "p", agentId: "a1" });
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { agent?: string }[] } };
    expect(r.summary.roles.every((x) => x.agent === "a1")).toBe(true);
  });

  it("chat.send runs the general-worker role: prompt + filtered tools + turn budget", async () => {
    const bodies: string[] = [];
    const fetcher = async (_u: string, init: { body?: string }) => {
      bodies.push(init.body ?? "");
      return { status: 200, headers: {}, body: null };
    };
    const events: RunEvent[] = [];
    const core = new Core({
      defaults,
      userConfig: memStore({
        "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n    tools: [ReadFile, WriteFile]\n    turnBudget: 1\n",
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
    const sent = JSON.parse(bodies[0]) as { messages: { role: string; content: string }[] };
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("General Worker");
    expect(sent.messages[0].content).toContain("# Skill: execution-contract");
    expect(sent.messages[1].content).toBe("hi");
  });

  it("chat.send fails on an enabled role with no agent instead of falling back", async () => {
    const core = new Core({
      defaults,
      userConfig: memStore({ "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n" }),
      projectConfig: async () => memStore(),
      fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost().host);
    await expect(core.dispatch("chat.send", { projectId: "p", text: "hi" })).rejects.toThrow(/enabled but no agent bound/);
  });

  it("surfaces role binding problems as config errors", async () => {
    const { core } = mk({ "roles.yaml": "version: 1\nitems:\n  - id: planner\n    enabled: true\n" });
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { errors: string[] };
    expect(r.errors).toContain("role planner: enabled but no agent bound");
    expect(r.errors).toContain("orchestrator: required when another role is enabled");
  });

  it("chat.send runs role-less when general-worker is disabled", async () => {
    const bodies: string[] = [];
    const fetcher = async (_u: string, init: { body?: string }) => {
      bodies.push(init.body ?? "");
      return { status: 200, headers: {}, body: null };
    };
    const core = new Core({
      defaults,
      userConfig: memStore({}),
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
    // No role prompt: the only system message is the workspace context plus the shim-mode tools block.
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("# Workspace\nProject root: /p");
    expect(sent.messages[0].content).toContain("<tools>");
    expect(sent.messages[0].content).not.toContain("ROLE:");
    expect(sent.messages[1]).toMatchObject({ role: "user", content: "hi" });
  });
});

describe("code-health-reviewer role", () => {
  const shipped = () => (parseYaml(DEFAULT_ROLES_YAML) as { items: RoleDef[] }).items;
  const r = () => shipped().find((x) => x.id === "code-health-reviewer")!;
  it("ships disabled and read-only", () => {
    expect(r()).toBeDefined();
    expect(r().enabled).toBe(false);
    expect(r().skills).toContain("code-health");
    for (const t of ["WriteFile", "EditFile", "ApplyPatch"]) expect(r().tools).not.toContain(t);
  });
  it("has the read tools its input scopes need plus CodeMetrics and RunTerminal for project checks", () => {
    for (const t of ["ReadFile", "FindFiles", "Search", "CodeMetrics", "RunTerminal"]) expect(r().tools).toContain(t);
  });
  it("every shipped role references only shipped skills", () => {
    const ids = new Set(DEFAULT_SKILLS.map((s) => s.id));
    for (const x of shipped()) for (const s of x.skills) expect(ids.has(s), `${x.id}:${s}`).toBe(true);
  });
  it("existing user roles.yaml still receives the shipped role", () => {
    const user = stringifyYaml({ version: 1, items: [{ id: "tester", enabled: true }] });
    const cfg = loadEffectiveConfig({ "roles.yaml": user }, undefined, { "roles.yaml": DEFAULT_ROLES_YAML }, true);
    expect(cfg.roles.some((x) => x.id === "code-health-reviewer")).toBe(true);
  });
  it("is not write-capable; tester still is", () => {
    expect(isWriteCapableRole(r())).toBe(false);
    expect(isWriteCapableRole(shipped().find((x) => x.id === "tester")!)).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { agentServesRole, matchGlob, roleRegistry, roleTurnBudget, validateRoles } from "../src/roles.js";
import { projectTools } from "../src/tools/builtins.js";
import { ProjectPaths } from "../src/tools/projectPaths.js";
import { ToolRegistry, type Tool } from "../src/tools/types.js";
import { fakeHost } from "@stewart/kernel";
import type { RoleDef } from "../src/config/schema.js";
import { Core } from "../src/core.js";
import { fakeFetcher } from "@stewart/kernel";
import type { ConfigStore } from "../src/config/store.js";
import type { ConfigLayer } from "../src/config/loader.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_ROLES_YAML } from "../src/defaults/roles.js";
import { DEFAULT_SKILLS } from "../src/defaults/skills.js";
import { loadConfig } from "../src/config/loader.js";
import { isWriteCapableRole } from "../src/roles.js";
import type { RunEvent } from "@stewart/protocol";

const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 25, ...over,
});

describe("matchGlob", () => {
  it("matches ** across directories and * within a segment", () => {
    expect(matchGlob("docs/**", "docs/a/b/c.md")).toBe(true);
    expect(matchGlob("docs/**", "src/a.md")).toBe(false);
    expect(matchGlob("*.md", "README.md")).toBe(true);
    expect(matchGlob("*.md", "docs/README.md")).toBe(false);
    expect(matchGlob("CHANGELOG*", "CHANGELOG.md")).toBe(true);
    expect(matchGlob("assets/*.svg", "assets/x.svg")).toBe(true);
    expect(matchGlob("assets/*.svg", "assets/a/b.svg")).toBe(false);
  });
});

describe("roleRegistry", () => {
  const mk = async () => {
    const { host } = fakeHost({ "a.ts": "x", "docs/x.md": "d" });
    const paths = await ProjectPaths.forProject(host);
    return projectTools(host, paths);
  };

  it("filters tools to the role list", async () => {
    const reg = roleRegistry(await mk(), role({ tools: ["ReadFile", "Search"] }));
    expect(reg.tools.map((t) => t.spec.name).sort()).toEqual(["ReadFile", "Search"]);
    expect(reg.find("WriteFile")).toBeUndefined();
  });

  it("empty tools list means unrestricted", async () => {
    const all = await mk();
    const reg = roleRegistry(all, role({ tools: [] }));
    expect(reg.tools.length).toBe(all.tools.length);
  });

  it("enforces the investigator read-only program allow-list on RunTerminal", async () => {
    const reg = roleRegistry(await mk(), role({ id: "investigator", tools: ["RunTerminal"] }));
    const term = reg.find("RunTerminal")!;
    await expect(term.preview!({ command: "ls -la" })).resolves.toBeTruthy();
    await expect(term.preview!({ command: "git status" })).resolves.toBeTruthy();
    await expect(term.preview!({ command: "git diff HEAD" })).resolves.toBeTruthy();
    await expect(term.preview!({ command: "rm -rf src" })).rejects.toThrow(/not allowed for read-only role investigator/);
    await expect(term.preview!({ command: "git commit -m wip" })).rejects.toThrow(/not allowed for read-only role investigator/);
    await expect(term.preview!({ command: "echo pwn > a.ts" })).rejects.toThrow(/not allowed for read-only role investigator/);
  });

  it("rejects a write outside writePaths before preview", async () => {
    const reg = roleRegistry(await mk(), role({ tools: ["WriteFile"], writePaths: ["docs/**"] }));
    const w = reg.find("WriteFile")!;
    await expect(w.preview!({ path: "src/x.ts", content: "c" })).rejects.toThrow(/outside this role's writePaths/);
    await expect(w.preview!({ path: "docs/x.md", content: "c" })).resolves.toBeTruthy();
  });

  it("unrestricted writePaths allow any path", async () => {
    const reg = roleRegistry(await mk(), role({ tools: ["WriteFile"], writePaths: [] }));
    await expect(reg.find("WriteFile")!.preview!({ path: "src/x.ts", content: "c" })).resolves.toBeTruthy();
  });

  it("does not wrap non-path tools", async () => {
    const reg = roleRegistry(await mk(), role({ tools: ["RunTerminal"], writePaths: ["docs/**"] }));
    expect(reg.find("RunTerminal")).toBeDefined();
  });
});

describe("validateRoles", () => {
  const agent = (over: Record<string, unknown> = {}) =>
    ({ id: "a1", channel: "c1", model: "m", effort: "medium", ...over }) as never;
  const channel = (caps: Record<string, Record<string, unknown>> = {}) =>
    ({ id: "c1", type: "ollama", enabled: true, discoverModels: true, extraModels: [], modelCaps: caps }) as never;
  const visionAgent = agent({ id: "va", model: "v" });

  it("flags an enabled role with no agent bound", () => {
    expect(validateRoles([role({ id: "general-worker" })], [agent()], [channel()])).toContain(
      "role general-worker: enabled but no agent bound",
    );
  });

  it("flags an unknown agent and fallback agent", () => {
    const errs = validateRoles([role({ id: "general-worker", agent: "nope", fallbackAgent: "gone" })], [agent()], [channel()]);
    expect(errs).toContain("role general-worker: unknown agent 'nope'");
    expect(errs).toContain("role general-worker: unknown fallbackAgent 'gone'");
  });

  it("requires the orchestrator once another role is enabled", () => {
    const errs = validateRoles([role({ id: "general-worker", agent: "a1" })], [agent()], [channel()]);
    expect(errs).toContain("orchestrator: required when another role is enabled");
    const ok = validateRoles([role({ id: "orchestrator", agent: "a1" }), role({ id: "general-worker", agent: "a1" })], [agent()], [channel()]);
    expect(ok).toEqual([]);
  });

  it("enforces role capabilities on agent and fallback agent", () => {
    const chans = [channel({ v: { vision: true } })];
    const errs = validateRoles(
      [role({ id: "orchestrator", agent: "a1" }), role({ id: "image-reader", agent: "a1", fallbackAgent: "va" })],
      [agent(), visionAgent],
      chans,
    );
    expect(errs).toContain("role image-reader: agent 'a1' lacks vision");
    const ok = validateRoles(
      [role({ id: "orchestrator", agent: "a1" }), role({ id: "image-reader", agent: "va" })],
      [agent(), visionAgent],
      chans,
    );
    expect(ok).toEqual([]);
    expect(agentServesRole(visionAgent, chans, "image-writer")).toBe(false);
  });

  it("disabled roles produce no errors", () => {
    expect(validateRoles([role({ id: "code-writer", enabled: false })], [], [])).toEqual([]);
  });
});

describe("roleTurnBudget", () => {
  it("maps numbers and unlimited", () => {
    expect(roleTurnBudget(role({ turnBudget: 7 }))).toBe(7);
    expect(roleTurnBudget(role({ turnBudget: "unlimited" }))).toBe(Number.MAX_SAFE_INTEGER);
  });
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
    // No role prompt, but shim mode injects the tools block as the only system message.
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content.startsWith("<tools>")).toBe(true);
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
    for (const t of ["WriteFile", "EditFile", "ApplyPatch", "RunTerminal"]) expect(r().tools).not.toContain(t);
  });
  it("has the read tools its input scopes need", () => {
    for (const t of ["ReadFile", "FindFiles", "Search"]) expect(r().tools).toContain(t);
  });
  it("every shipped role references only shipped skills", () => {
    const ids = new Set(DEFAULT_SKILLS.map((s) => s.id));
    for (const x of shipped()) for (const s of x.skills) expect(ids.has(s), `${x.id}:${s}`).toBe(true);
  });
  it("existing user roles.yaml still receives the shipped role", () => {
    const user = stringifyYaml({ version: 1, items: [{ id: "tester", enabled: true }] });
    const cfg = loadConfig({ "roles.yaml": user }, undefined, { "roles.yaml": DEFAULT_ROLES_YAML }, true);
    expect(cfg.roles.some((x) => x.id === "code-health-reviewer")).toBe(true);
  });
  it("is not write-capable; tester still is", () => {
    expect(isWriteCapableRole(r())).toBe(false);
    expect(isWriteCapableRole(shipped().find((x) => x.id === "tester")!)).toBe(true);
  });
});

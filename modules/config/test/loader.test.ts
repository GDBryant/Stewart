import { describe, expect, it } from "vitest";
import { SelfWriteGuard, hashContent, isProjectFile, loadConfig } from "../src/api.js";

const role = (id: string, turns = 10) => `version: 1\nitems:\n  - id: ${id}\n    enabled: true\n    skills: []\n    tools: []\n    writePaths: []\n    turnBudget: ${turns}\n`;

describe("loadConfig", () => {
  it("merges shipped < user < project roles by id, field by field", () => {
    const c = loadConfig({ "roles.yaml": role("r", 20) }, { "roles.yaml": role("r", 30) }, { "roles.yaml": role("r") }, { trusted: true });
    expect(c.errors).toEqual([]);
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0].turnBudget).toBe(30);
  });
  it("ignores the project layer in an untrusted workspace and says so", () => {
    const c = loadConfig({}, { "roles.yaml": role("r") }, {}, { trusted: false });
    expect(c.roles).toEqual([]);
    expect(c.errors.join()).toMatch(/untrusted/);
  });
  it("does not flag an untrusted workspace that carries no roles or skills", () => {
    const c = loadConfig({}, { "settings.yaml": "version: 1\n" }, {}, { trusted: false });
    expect(c.errors).toEqual([]);
  });
  it("reports schema errors per file and keeps going", () => {
    const c = loadConfig({ "roles.yaml": "version: 1\nitems: 5\n" }, undefined, {}, { trusted: true });
    expect(c.errors[0]).toMatch(/^roles.yaml:/);
  });
});

describe("required role tools union", () => {
  const REQUIRED = { orchestrator: ["ListCodeFiles", "health_report"], "code-health-reviewer": ["ListCodeFiles", "submit_health", "CodeMetrics", "RunTerminal"] };
  const shipped = (tools: string) => `version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: [${tools}]\n  - id: code-health-reviewer\n    enabled: true\n    tools: [ReadFile, submit_health]\n  - id: investigator\n    enabled: true\n    tools: [ReadFile]\n`;

  it("appends required tools to a stale user roles.yaml and leaves other roles untouched", () => {
    const user = `version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: [dispatch, ask_user, ReadFile, FindFiles]\n  - id: code-health-reviewer\n    enabled: true\n    tools: [ReadFile, Search]\n`;
    const c = loadConfig({ "roles.yaml": user }, undefined, { "roles.yaml": shipped("dispatch") }, { trusted: true, requiredRoleTools: REQUIRED });
    const o = c.roles.find((r) => r.id === "orchestrator")!;
    expect(o.tools).toEqual(["dispatch", "ask_user", "ReadFile", "FindFiles", "ListCodeFiles", "health_report"]);
    const h = c.roles.find((r) => r.id === "code-health-reviewer")!;
    expect(h.tools).toEqual(["ReadFile", "Search", "ListCodeFiles", "submit_health", "CodeMetrics", "RunTerminal"]);
    expect(c.roles.find((r) => r.id === "investigator")!.tools).toEqual(["ReadFile"]);
  });

  it("adds nothing when no required tools are supplied", () => {
    const user = `version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: [dispatch, ask_user]\n`;
    const c = loadConfig({ "roles.yaml": user }, undefined, { "roles.yaml": shipped("dispatch") }, { trusted: true });
    expect(c.roles.find((r) => r.id === "orchestrator")!.tools).toEqual(["dispatch", "ask_user"]);
  });

  it("does not duplicate tools already present", () => {
    const user = `version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: [dispatch, ListCodeFiles, health_report]\n`;
    const c = loadConfig({ "roles.yaml": user }, undefined, { "roles.yaml": shipped("dispatch") }, { trusted: true, requiredRoleTools: REQUIRED });
    expect(c.roles.find((r) => r.id === "orchestrator")!.tools).toEqual(["dispatch", "ListCodeFiles", "health_report"]);
  });

  it("leaves a role with an empty tools list empty", () => {
    const user = `version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: []\n`;
    const c = loadConfig({ "roles.yaml": user }, undefined, { "roles.yaml": shipped("dispatch") }, { trusted: true, requiredRoleTools: REQUIRED });
    expect(c.roles.find((r) => r.id === "orchestrator")!.tools).toEqual([]);
  });

  it("does not add the shipped ids when absent from all layers", () => {
    const c = loadConfig({ "roles.yaml": "version: 1\nitems:\n  - id: custom\n    enabled: true\n    tools: [ReadFile, ListCodeFiles, submit_health]\n" }, undefined, {}, { trusted: true, requiredRoleTools: REQUIRED });
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0].tools).toEqual(["ReadFile", "ListCodeFiles", "submit_health"]);
  });
});

describe("store helpers", () => {
  it("SelfWriteGuard recognises its own writes only; only roles.yaml is a project file", () => {
    const g = new SelfWriteGuard();
    g.recordWrite("a.yaml", "x");
    expect(g.isSelfWrite("a.yaml", "x")).toBe(true);
    expect(g.isSelfWrite("a.yaml", "y")).toBe(false);
    g.recordDelete("a.yaml");
    expect(g.isSelfWrite("a.yaml", "x")).toBe(false);
    expect(hashContent("x")).toBe(hashContent("x"));
    expect(isProjectFile("roles.yaml")).toBe(true);
    expect(isProjectFile("channels.yaml")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { SelfWriteGuard, hashContent, isProjectFile, loadConfig } from "../src/api.js";

const role = (id: string, turns = 10) => `version: 1\nitems:\n  - id: ${id}\n    enabled: true\n    skills: []\n    tools: []\n    writePaths: []\n    turnBudget: ${turns}\n`;

describe("loadConfig", () => {
  it("merges shipped < user < project roles by id, field by field", () => {
    const c = loadConfig({ "roles.yaml": role("r", 20) }, { "roles.yaml": role("r", 30) }, { "roles.yaml": role("r") }, true);
    expect(c.errors).toEqual([]);
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0].turnBudget).toBe(30);
  });
  it("ignores the project layer in an untrusted workspace and says so", () => {
    const c = loadConfig({}, { "roles.yaml": role("r") }, {}, false);
    expect(c.roles).toEqual([]);
    expect(c.errors.join()).toMatch(/untrusted/);
  });
  it("reports schema errors per file and keeps going", () => {
    const c = loadConfig({ "roles.yaml": "version: 1\nitems: 5\n" }, undefined, {}, true);
    expect(c.errors[0]).toMatch(/^roles.yaml:/);
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

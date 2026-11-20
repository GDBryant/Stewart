import { describe, expect, it } from "vitest";
import { matchGlob, validateRoles } from "../src/api.js";
import { DEFAULT_ROLES_YAML } from "../src/defaults/roles.js";
import { rolesFile } from "@stewart/config";
import { parse } from "yaml";
import type { RoleDef } from "@stewart/config";

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

describe("validateRoles", () => {
  const agent = (over: Record<string, unknown> = {}) =>
    ({ id: "a1", channel: "c1", model: "m", effort: "medium", ...over }) as never;
  const channel = (caps: Record<string, Record<string, unknown>> = {}) =>
    ({ id: "c1", type: "ollama", enabled: true, discoverModels: true, extraModels: [], modelCaps: caps }) as never;
  const visionAgent = agent({ id: "va", model: "v" });

  it("accepts an enabled role with no agent bound (falls back to the lead's agent)", () => {
    expect(validateRoles([role({ id: "general-worker" })], [agent()], [channel()])).toEqual([]);
  });

  it("flags an unknown agent; old role ids validate without an orchestrator", () => {
    const errs = validateRoles([role({ id: "general-worker", agent: "nope" })], [agent()], [channel()]);
    expect(errs).toContain("role general-worker: unknown agent 'nope'");
    const ok = validateRoles([role({ id: "general-worker", agent: "a1" })], [agent()], [channel({ m: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } } })]);
    expect(ok).toEqual([]);
    expect(validateRoles([role({ id: "general-worker", agent: "a1" })], [agent()], [channel()])).toEqual(["role general-worker: agent 'a1' not qualified as agent (run Qualify)"]);
  });

  it("lead may be enabled with no agents configured", () => {
    expect(validateRoles([role({ id: "lead" })], [], [])).toEqual([]);
  });

  it("disabled roles produce no errors", () => {
    expect(validateRoles([role({ id: "code-writer", enabled: false })], [], [])).toEqual([]);
  });
});



describe("default roles think", () => {
  it("auditor ships think:false; other roles leave it unset", () => {
    const items = rolesFile.parse(parse(DEFAULT_ROLES_YAML)).items;
    expect(items.find((r) => r.id === "auditor")?.think).toBe(false);
    expect(items.filter((r) => r.id !== "auditor").every((r) => r.think === undefined)).toBe(true);
  });
});

describe("default review/audit split", () => {
  it("reviewer reviews code; auditor runs code-health", () => {
    const items = rolesFile.parse(parse(DEFAULT_ROLES_YAML)).items;
    expect(items.find((r) => r.id === "reviewer")?.skills).toEqual(["code-review"]);
    expect(items.find((r) => r.id === "auditor")?.skills).toEqual(["code-health"]);
  });
});

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { rolesFile } from "@stewart/config";
import { DEFAULT_ROLES_YAML } from "../src/defaults/roles.js";
import { DEFAULT_SKILLS } from "../src/defaults/skills.js";
import { matchGlob } from "../src/api.js";

const roles = () => rolesFile.parse(parse(DEFAULT_ROLES_YAML)).items;
const byId = (id: string) => roles().find((r) => r.id === id)!;
const TOOLS = new Set(["ReadFile", "FindFiles", "ListCodeFiles", "Search", "GetProblems", "GetDiff", "ReadImage", "WriteFile", "EditFile", "ApplyPatch", "RunTerminal", "CodeMetrics", "load_skill", "ask_user", "delegate", "health_report", "set_check", "plan_write"]);
const WRITE = ["WriteFile", "EditFile", "ApplyPatch"];

describe("golden roles", () => {
  it("ships the 11 roles, all disabled and unbound", () => {
    expect(roles().map((r) => r.id).sort()).toEqual(["auditor", "builder", "documenter", "explorer", "interrogator", "investigator", "lead", "planner", "reviewer", "spec-writer", "tester"]);
    for (const r of roles()) {
      expect(r.enabled, r.id).toBe(false);
      expect(r.agent, r.id).toBeUndefined();
    }
  });

  it("every tool and bound skill is real (negative: no typos)", () => {
    const skills = new Set(DEFAULT_SKILLS.map((s) => s.id));
    for (const r of roles()) {
      for (const t of r.tools) expect(TOOLS.has(t), `${r.id}:${t}`).toBe(true);
      for (const s of r.skills) expect(skills.has(s), `${r.id}:${s}`).toBe(true);
    }
    expect(skills.has("nope")).toBe(false);
  });

  it("only builder, documenter and tester can write", () => {
    const writers = roles().filter((r) => r.tools.some((t) => WRITE.includes(t))).map((r) => r.id).sort();
    expect(writers).toEqual(["builder", "documenter", "lead", "tester"]);
    for (const id of ["planner", "interrogator", "spec-writer", "investigator", "reviewer"]) {
      expect(byId(id).tools.some((t) => WRITE.includes(t)), id).toBe(false);
    }
  });

  it("documenter writes docs only", () => {
    const wp = byId("documenter").writePaths;
    expect(wp).toEqual(["docs/**", "**/*.md", "CHANGELOG*"]);
    const ok = (p: string) => wp.some((g) => matchGlob(g, p));
    expect(ok("docs/a.md")).toBe(true);
    expect(ok("src/a.ts")).toBe(false);
  });

  it("skill bodies stay inside the prompt budget", () => {
    const body = new Map(DEFAULT_SKILLS.map((s) => [s.id, s.body.length]));
    for (const r of roles()) expect(r.skills.reduce((n, s) => n + (body.get(s) ?? 0), 0), r.id).toBeLessThanOrEqual(8000 * 4);
  });

  it("golden-pipeline skill is bound to lead and names the roles and tools", () => {
    expect(byId("lead").skills).toEqual(expect.arrayContaining(["project-health", "golden-pipeline"]));
    const skill = DEFAULT_SKILLS.find((s) => s.id === "golden-pipeline")!;
    expect(skill.body.length).toBeLessThan(2000);
    for (const w of ["plan_write", "ask_user", "delegate", "planner", "interrogator", "spec-writer", "builder", "investigator", "reviewer", "documenter"]) expect(skill.body).toContain(w);
    for (const w of ["Inventory first", "inline", "never skipped", "re-interrogate", "single-role mode", "weakened independence"]) expect(skill.body, w).toContain(w);
    expect(byId("planner").skills).not.toContain("golden-pipeline");
  });
});

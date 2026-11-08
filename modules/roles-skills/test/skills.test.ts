import { describe, expect, it } from "vitest";
import {
  baseHashFor, composeRolePrompt, hashBody, parseSkillMd, resolveSkills, serializeSkillMd, shippedSkill, TRUNCATED_MARKER,
} from "../src/api.js";
import { DEFAULT_SKILLS, DEFAULT_ROLES_YAML } from "../src/api.js";
import { parse as parseYaml } from "yaml";
import type { RoleDef } from "@stewart/config";

const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 25, ...over,
});

const skillMd = (id: string, body: string, baseHash?: string) =>
  `---\nid: ${id}\ndescription: d\nversion: 1${baseHash ? `\nbaseHash: ${baseHash}` : ""}\n---\n${body}\n`;

describe("parseSkillMd / serializeSkillMd", () => {
  it("round-trips frontmatter and body", () => {
    const text = serializeSkillMd({ id: "s1", description: "desc", defaultRoles: ["a"], version: 3, baseHash: "h" }, "do things");
    const { meta, body } = parseSkillMd(text, "x");
    expect(meta).toMatchObject({ id: "s1", description: "desc", defaultRoles: ["a"], version: 3, baseHash: "h" });
    expect(body).toBe("do things");
  });

  it("tolerates missing frontmatter", () => {
    const { meta, body } = parseSkillMd("plain body", "fb");
    expect(meta.id).toBe("fb");
    expect(body).toBe("plain body");
  });
});

describe("resolveSkills", () => {
  it("returns shipped skills with no layers", () => {
    const skills = resolveSkills({}, undefined);
    expect(skills.length).toBe(DEFAULT_SKILLS.length);
    expect(skills.every((s) => s.source === "shipped")).toBe(true);
  });

  it("unedited copy (body hash == baseHash) tracks the shipped body", () => {
    const shipped = shippedSkill("tdd")!;
    const user = { "skills/tdd.md": skillMd("tdd", shipped.body, hashBody(shipped.body)) };
    const s = resolveSkills(user, undefined).find((x) => x.id === "tdd")!;
    expect(s.source).toBe("shipped");
    expect(s.body).toBe(shipped.body);
  });

  it("edited copy keeps its body and flags updateAvailable when shipped moved", () => {
    const user = { "skills/tdd.md": skillMd("tdd", "my custom tdd", "oldhash") };
    const s = resolveSkills(user, undefined).find((x) => x.id === "tdd")!;
    expect(s).toMatchObject({ source: "user", edited: true, body: "my custom tdd", updateAvailable: true });
  });

  it("edited copy up to date with shipped shows no update badge", () => {
    const shipped = shippedSkill("tdd")!;
    const user = { "skills/tdd.md": skillMd("tdd", "edited body", hashBody(shipped.body)) };
    const s = resolveSkills(user, undefined).find((x) => x.id === "tdd")!;
    expect(s.updateAvailable).toBe(false);
  });

  it("user-created skills appear without a shipped counterpart", () => {
    const s = resolveSkills({ "skills/mine.md": skillMd("mine", "custom") }, undefined).find((x) => x.id === "mine")!;
    expect(s).toMatchObject({ source: "user", edited: false, body: "custom" });
  });

  it("project skills override user and shipped", () => {
    const s = resolveSkills(
      { "skills/tdd.md": skillMd("tdd", "user body") },
      { "skills/tdd.md": skillMd("tdd", "project body") },
    ).find((x) => x.id === "tdd")!;
    expect(s).toMatchObject({ source: "project", body: "project body" });
  });

  it("baseHashFor returns the shipped body hash", () => {
    expect(baseHashFor("tdd")).toBe(hashBody(shippedSkill("tdd")!.body));
    expect(baseHashFor("nonexistent")).toBeUndefined();
  });
});

describe("composeRolePrompt", () => {
  const skills = resolveSkills({}, undefined);

  it("orders role prompt then ticked skills", () => {
    const { prompt } = composeRolePrompt(role({ prompt: "PROMPT", skills: ["tdd", "adr"] }), skills, 8000);
    const pi = prompt.indexOf("PROMPT");
    expect(pi).toBe(0);
    expect(prompt.indexOf("# Skill: tdd")).toBeLessThan(prompt.indexOf("# Skill: adr"));
  });

  it("force-includes execution-contract for write-tool roles", () => {
    const { prompt } = composeRolePrompt(role({ tools: ["ReadFile", "WriteFile"], skills: ["tdd"] }), skills, 8000);
    expect(prompt).toContain("# Skill: execution-contract");
  });

  it("does not force execution-contract for read-only roles", () => {
    const { prompt } = composeRolePrompt(role({ tools: ["ReadFile", "Search"], skills: ["tdd"] }), skills, 8000);
    expect(prompt).not.toContain("execution-contract");
  });

  it("truncates the last skill at the token budget with a marker", () => {
    const { prompt, truncated } = composeRolePrompt(role({ prompt: "P", skills: ["tdd", "adr", "orchestrate"] }), skills, 30);
    expect(truncated).toBe(true);
    expect(prompt).toContain(TRUNCATED_MARKER.trim());
  });

  it("skips unknown skill ids", () => {
    const { prompt } = composeRolePrompt(role({ skills: ["nope", "tdd"] }), skills, 8000);
    expect(prompt).toContain("# Skill: tdd");
  });
});

describe("orchestrate skill", () => {
  const body = () => shippedSkill("orchestrate")!.body;
  it("states the project health-check procedure", () => {
    for (const x of ["ListCodeFiles", "health_report", "code-health-reviewer", "never read docs"]) expect(body()).toContain(x);
  });
  it("does not mention phases", () => {
    expect(body()).not.toContain("phase");
  });
  it("the shipped orchestrator prompt is not truncated at the default budget", () => {
    const skills = resolveSkills({}, undefined);
    const orchestrator = (parseYaml(DEFAULT_ROLES_YAML) as { items: RoleDef[] }).items.find((r) => r.id === "orchestrator")!;
    const { truncated } = composeRolePrompt(orchestrator, skills, 8000);
    expect(truncated).toBe(false);
  });
});

describe("code-health skill", () => {
  const body = () => shippedSkill("code-health")!.body;
  it("ships with a non-empty body distinct from code-review", () => {
    expect(body().length).toBeGreaterThan(50);
    expect(body()).not.toBe(shippedSkill("code-review")!.body);
  });
  it("returns undefined for an unknown skill id", () => {
    expect(shippedSkill("no-such-skill")).toBeUndefined();
  });
  it("names both modes, the scale and the bands", () => {
    for (const x of ["score", "issues", "10", "9.5", "Green", "Yellow", "Red"]) expect(body()).toContain(x);
  });
  it("covers every input scope", () => {
    for (const x of ["file", "folder", "line", "function", "code block"]) expect(body().toLowerCase()).toContain(x);
  });
  it("states it is an approximation and read-only", () => {
    expect(body().toLowerCase()).toContain("approximat");
    expect(body().toLowerCase()).toContain("do not edit");
  });
  it("does not instruct running tools or editing", () => {
    expect(body()).not.toMatch(/run (the )?(tests|terminal|coverage|lint)/i);
    expect(body()).not.toContain("RunTerminal");
    expect(body()).not.toContain("edit the file");
  });
  it("contains the exact output line formats", () => {
    expect(body()).toContain("path:line | smell | high/med/low | refactor");
    expect(body()).toContain("/10 (");
  });
  it("stays under the size budget", () => {
    expect(body().length).toBeLessThan(2600);
  });
  it("covers listed-file scope and the submit_health path", () => {
    expect(body()).toContain("every listed file");
    expect(body()).toContain("submit_health");
  });
});

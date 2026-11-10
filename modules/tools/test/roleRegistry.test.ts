import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/types.js";
import { projectTools } from "../src/builtins.js";
import { ProjectPaths } from "../src/projectPaths.js";
import { fakeHost } from "@stewart/kernel";
import { loadConfig } from "@stewart/config";
import { DEFAULT_ROLES_YAML } from "@stewart/roles-skills";
import type { RoleDef } from "@stewart/config";

const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 25, ...over,
});

describe("ToolRegistry.for", () => {
  const mk = async () => {
    const { host } = fakeHost({ "a.ts": "x", "docs/x.md": "d" });
    const paths = await ProjectPaths.forProject(host);
    return projectTools(host, paths);
  };

  it("filters tools to the role list", async () => {
    const reg = (await mk()).for(role({ tools: ["ReadFile", "Search"] }));
    expect(reg.tools.map((t) => t.spec.name).sort()).toEqual(["ReadFile", "Search"]);
    expect(reg.find("WriteFile")).toBeUndefined();
  });

  it("empty tools list means unrestricted", async () => {
    const all = await mk();
    const reg = all.for(role({ tools: [] }));
    expect(reg.tools.length).toBe(all.tools.length);
  });

  it("the shipped code-health-reviewer registry exposes CodeMetrics and RunTerminal", async () => {
    const cfg = loadConfig({}, undefined, { "roles.yaml": DEFAULT_ROLES_YAML }, false);
    const reviewer = cfg.roles.find((r) => r.id === "code-health-reviewer")!;
    const reg = (await mk()).for(reviewer);
    const names = reg.tools.map((t) => t.spec.name);
    expect(names).toContain("CodeMetrics");
    expect(names).toContain("RunTerminal");
  });

  it("enforces the investigator read-only program allow-list on RunTerminal", async () => {
    const reg = (await mk()).for(role({ id: "investigator", tools: ["RunTerminal"] }));
    const term = reg.find("RunTerminal")!;
    await expect(term.preview!({ command: "ls -la" })).resolves.toBeTruthy();
    await expect(term.preview!({ command: "git status" })).resolves.toBeTruthy();
    await expect(term.preview!({ command: "git diff HEAD" })).resolves.toBeTruthy();
    await expect(term.preview!({ command: "rm -rf src" })).rejects.toThrow(/not allowed for read-only role investigator/);
    await expect(term.preview!({ command: "git commit -m wip" })).rejects.toThrow(/not allowed for read-only role investigator/);
    await expect(term.preview!({ command: "echo pwn > a.ts" })).rejects.toThrow(/not allowed for read-only role investigator/);
  });

  it("rejects a write outside writePaths before preview", async () => {
    const reg = (await mk()).for(role({ tools: ["WriteFile"], writePaths: ["docs/**"] }));
    const w = reg.find("WriteFile")!;
    await expect(w.preview!({ path: "src/x.ts", content: "c" })).rejects.toThrow(/outside this role's writePaths/);
    await expect(w.preview!({ path: "docs/x.md", content: "c" })).resolves.toBeTruthy();
  });

  it("unrestricted writePaths allow any path", async () => {
    const reg = (await mk()).for(role({ tools: ["WriteFile"], writePaths: [] }));
    await expect(reg.find("WriteFile")!.preview!({ path: "src/x.ts", content: "c" })).resolves.toBeTruthy();
  });

  it("does not wrap non-path tools", async () => {
    const reg = (await mk()).for(role({ tools: ["RunTerminal"], writePaths: ["docs/**"] }));
    expect(reg.find("RunTerminal")).toBeDefined();
  });
});

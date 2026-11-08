import { describe, expect, it } from "vitest";
import { composeRolePrompt, resolveSkills, shippedSkill, DEFAULT_ROLES_YAML } from "@stewart/roles-skills";
import { parse as parseYaml } from "yaml";
import type { RoleDef } from "@stewart/config";

describe("shipped skill routing text", () => {
  it("orchestrate states the health-check procedure and never mentions phases", () => {
    const body = shippedSkill("orchestrate")!.body;
    for (const x of ["ListCodeFiles", "health_report", "code-health-reviewer", "never read docs", "path", `mode "score"`]) expect(body).toContain(x);
    expect(body).not.toContain("phase");
  });

  it("code-health covers every listed file and submit_health", () => {
    const body = shippedSkill("code-health")!.body;
    expect(body).toContain("every listed file");
    expect(body).toContain("submit_health");
  });

  it("the orchestrator prompt is not truncated at the default skill budget", () => {
    const orchestrator = (parseYaml(DEFAULT_ROLES_YAML) as { items: RoleDef[] }).items.find((r) => r.id === "orchestrator")!;
    const { truncated } = composeRolePrompt(orchestrator, resolveSkills({}, undefined), 8000);
    expect(truncated).toBe(false);
  });
});

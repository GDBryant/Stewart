import { describe, expect, it } from "vitest";
import { shippedSkill } from "@stewart/roles-skills";

describe("shipped skill routing text", () => {
  it("code-health covers every listed file, submit_health and CodeMetrics", () => {
    const body = shippedSkill("code-health")!.body;
    expect(body).toContain("every listed file");
    expect(body).toContain("submit_health");
    expect(body).toContain("CodeMetrics");
  });
});

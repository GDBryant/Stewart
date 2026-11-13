import { describe, expect, it } from "vitest";
import { currentMilestone, parsePlan, renderPlan, type Plan } from "../src/plan.js";

const plan: Plan = {
  goal: "build hello.js",
  status: "paused",
  sessionId: "s1",
  milestones: [
    { id: "M1", title: "print hello", detail: "create bin/hello.js", check: { command: ["node", "bin/hello.js", "--name", "a b"], files: ["bin/hello.js"] }, status: "pending" },
    { id: "M2", title: "name arg", detail: "", check: { files: ["bin/hello.js"] }, status: "done", checkpoint: "abc123" },
    { id: "M3", title: "cmd only", detail: "", check: { command: ["npm", "test"] }, status: "failed" },
  ],
};

describe("plan render + parse", () => {
  it("round-trips argv commands exactly, with optional parts omitted", () => {
    const text = renderPlan(plan);
    expect(text).toContain("# Plan: build hello.js");
    expect(text).toContain("Status: paused");
    expect(text).toContain("## M1: print hello [pending]");
    expect(text).toContain('Check: ["node","bin/hello.js","--name","a b"]; files: bin/hello.js');
    expect(text).toContain("Check: files: bin/hello.js");
    expect(text).not.toContain("Checkpoint: undefined");
    expect(text).not.toContain("Attempts:");
    const back = parsePlan(text);
    expect(back).toEqual(plan);
  });

  it("parses a legacy backticked string command as sh -c argv", () => {
    const text = "# Plan: x\n\nStatus: active\nSession: s\n\n## M1: t [pending]\nCheck: `npm test`; files: a.ts\nAttempts: 2\n";
    const back = parsePlan(text);
    expect(back.milestones[0].check).toEqual({ command: ["sh", "-c", "npm test"], files: ["a.ts"] });
    expect(back.milestones[0]).not.toHaveProperty("attempts");
  });

  it("reports clear parse errors", () => {
    expect(() => parsePlan("no header")).toThrow(/# Plan/);
    expect(() => parsePlan("# Plan: x\n\nStatus: active\nSession: s\n")).toThrow(/no milestones/);
    expect(() => parsePlan("# Plan: x\n\nStatus: bogus\nSession: s\n\n## M1: t [pending]\n")).toThrow(/Status/);
    expect(() => parsePlan("# Plan: x\n\nStatus: active\n\n## M1: t [pending]\n")).toThrow(/Session/);
    expect(() => parsePlan("# Plan: x\n\nStatus: active\nSession: s\n\n## M1: t [bogus]\n")).toThrow(/milestone header/);
    expect(() => parsePlan("# Plan: x\n\nStatus: active\nSession: s\n\n## M1: t [pending]\nCheck: bogus\n")).toThrow(/bad Check/);
  });

  it("currentMilestone returns the first pending one", () => {
    expect(currentMilestone(plan)?.id).toBe("M1");
    expect(currentMilestone({ ...plan, milestones: plan.milestones.map((m) => ({ ...m, status: "done" as const })) })).toBeUndefined();
  });

  it("a failed milestone stays current and blocks later ones", () => {
    const failed = { ...plan, milestones: [{ ...plan.milestones[0], status: "failed" as const }, { ...plan.milestones[1], status: "pending" as const }] };
    expect(currentMilestone(failed)?.id).toBe("M1");
  });
});

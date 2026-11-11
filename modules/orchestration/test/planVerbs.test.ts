import { describe, expect, it } from "vitest";
import type { RoleDef } from "@stewart/config";
import type { RunRuntime } from "@stewart/run-contract";
import { PlanVerbs } from "../src/planVerbs.js";

const role = { id: "orchestrator" } as RoleDef;

function fakeRt(over: Partial<{ planGate: boolean; maxReplans: number; prompt: unknown }> = {}) {
  const events: { kind: string }[] = [];
  const rt = {
    runId: "r1",
    maxReplans: over.maxReplans ?? 2,
    planGate: over.planGate ?? false,
    bus: { emit: (e: { kind: string }) => events.push(e) },
    prompt: over.prompt ?? (async () => ({ kind: "answered", value: { kind: "approve" } })),
  } as unknown as RunRuntime;
  return { rt, events };
}

describe("PlanVerbs", () => {
  it("records the plan and approves it when the gate is off", async () => {
    const { rt, events } = fakeRt();
    const plan = new PlanVerbs(rt, role);
    expect(plan.submitPlan({ milestones: [{ title: "a" }, { title: "b" }] })).toContain("2 milestone(s)");
    expect(await plan.submitVerdict({ verdict: "approve" })).toMatch(/approved/);
    expect(plan.isApproved).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(["plan.created", "plan.validated", "plan.approved"]);
  });

  it("asks the plan gate before approving and stays unapproved when the user revises", async () => {
    const { rt } = fakeRt({ planGate: true, prompt: async () => ({ kind: "answered", value: { kind: "revise", reason: "too big" } }) });
    const plan = new PlanVerbs(rt, role);
    plan.submitPlan({ milestones: [] });
    expect(await plan.submitVerdict({ verdict: "approve" })).toContain("revise (1/2)");
    expect(plan.isApproved).toBe(false);
  });

  it("does not approve when the gate prompt is withdrawn", async () => {
    const { rt } = fakeRt({ planGate: true, prompt: async () => ({ kind: "withdrawn" }) });
    const plan = new PlanVerbs(rt, role);
    expect(await plan.submitVerdict({ verdict: "approve" })).toBe("Plan not approved: prompt withdrawn.");
    expect(plan.isApproved).toBe(false);
  });

  it("replans on revise and reports the limit once maxReplans is exceeded", async () => {
    const { rt } = fakeRt({ maxReplans: 1 });
    const plan = new PlanVerbs(rt, role);
    expect(await plan.submitVerdict({ verdict: "revise", reasons: ["missing tests"] })).toContain("Re-dispatch the planner with these reasons: missing tests");
    expect(await plan.submitVerdict({ verdict: "revise" })).toContain("replan limit (1) is reached");
  });
});

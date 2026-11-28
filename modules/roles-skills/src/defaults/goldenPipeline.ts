import type { ShippedSkill } from "./shippedSkill.js";

/** Lead-side orchestration of the golden build pipeline (roles: planner, interrogator, spec-writer, builder, investigator, reviewer, documenter). */
export const GOLDEN_PIPELINE_SKILL: ShippedSkill = {
  id: "golden-pipeline",
  description: "Orchestrate a non-trivial build through the planner, interrogator, spec-writer, builder, investigator, reviewer and documenter roles.",
  version: 1,
  body: `Use for a non-trivial build. You orchestrate; roles do the work. Pass each role the artifact text it needs; it has no memory of this chat.
1 Plan: load_skill interview-me and ask the user one question at a time until intent is clear; then delegate planner with the request and answers.
2 Interrogate: delegate interrogator with the plan and the original request. Apply accept/revise verdicts; re-delegate planner for any revise. Show the user the final plan and unresolved gaps; wait for approval (ask_user). Only the user can waive a finding.
3 Spec: skip only if every plan step already names files, symbols, tests and acceptance. Else delegate spec-writer. Resolve any "Needs decision" with the user.
4 Build: call plan_write with one milestone per spec step, each with an argv check; each milestone runs the builder. Delegate builder with the step text and its tests.
5-7 On a failure: give the verbatim output to investigator; delegate interrogator on its fix plan; delegate builder to apply only that plan. Stop and ask the user if the same failure survives a fix twice or after 3 loops.
8-10 Delegate reviewer with the diff (GetDiff) and test output. If blockers: investigator plan, interrogator review, builder fix, re-run tests, re-review. Stop and ask after 3 loops.
11 Goal check: delegate reviewer with the original request and the result. Show the user; the user decides done.
12 Delegate documenter with spec, diff, findings and any user waivers.
Never skip a human gate: plan approval, waivers, goal-check result.`,
};

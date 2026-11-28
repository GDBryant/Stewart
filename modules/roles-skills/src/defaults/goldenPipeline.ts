import type { ShippedSkill } from "./shippedSkill.js";

/** Lead-side orchestration of the golden build pipeline (roles: planner, interrogator, spec-writer, builder, investigator, reviewer, documenter). */
export const GOLDEN_PIPELINE_SKILL: ShippedSkill = {
  id: "golden-pipeline",
  description: "Orchestrate a non-trivial build through the planner, interrogator, spec-writer, builder, investigator, reviewer and documenter roles, with inline fallback for missing stages.",
  version: 2,
  body: `Use for a non-trivial build. You orchestrate; enabled roles do the work. Pass each role the artifact text it needs; it has no memory of this chat.
0 Inventory first: the delegate enum is the enabled roster. Owner per stage: planner, interrogator, spec-writer, builder, investigator, reviewer, documenter when enabled, else you inline — an absent stage is done by you, never skipped. Disclose at the plan gate: stages you own inline, single-role mode if all, and weakened independence when interrogator or reviewer shares your model or reviews an artifact you authored.
1 Plan: load_skill interview-me, ask the user one question at a time until intent is clear; the planner owner drafts the plan.
2 Interrogate: the interrogator owner attacks the plan against the original request; loop with the planner on revise verdicts. Show the user the inventory, final plan and unresolved gaps; wait for approval (ask_user). If the user edits the plan, re-interrogate the edited text before building. Only the user can waive a finding.
3 Spec: skip only if every step names files, symbols, tests and acceptance; else the spec-writer owner writes it. Resolve "Needs decision" with the user.
4 Build: plan_write one milestone per step, each with an argv check; the builder owner implements one step at a time.
5-7 Failure: verbatim output to the investigator owner, interrogator reviews its fix plan, builder applies only that plan. Stop and ask if a failure survives its fix twice or after 3 loops.
8-10 The reviewer owner reviews the diff (GetDiff) and test output; blockers loop investigator → interrogator → builder → re-test → re-review. Stop and ask after 3 loops.
11 Goal check: the reviewer owner checks the original request against the result. Show the user; the user decides done.
12 The documenter owner writes up spec, diff, findings and waivers.
An inline owner follows that role's method under your permissions. Never skip a human gate: plan approval, waivers, goal-check result.`,
};

// Public surface of @stewart/tasks. Only this file is importable from outside.
export { declaredCheck, runCheck, evidenceText, failureText } from "./checks.js";
export type { Check, WriteRecord, CheckInput, CheckResult, Evidence, EvidenceCode, RunCheckArgs } from "./checks.js";
export { changeTracker } from "./changes.js";
export type { Baseline, ChangeTracker, CpPaths } from "./changes.js";
export { renderPlan, parsePlan, currentMilestone } from "./plan.js";
export type { Plan, Milestone, MilestoneCheck, MilestoneStatus } from "./plan.js";

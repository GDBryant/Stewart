import type { ShippedSkill } from "./shippedSkill.js";

/** Shipped skills for the golden build pipeline (plan → interrogate → spec → build → investigate → review → document). See docs/GOLDEN_STEPS_ROLES_SKILLS.md. */
export const PIPELINE_SKILLS: ShippedSkill[] = [
  {
    id: "interview-me",
    description: "Elicit what the user actually wants, one question at a time, before planning.",
    version: 1,
    body: `Before planning, find the real intent. Read the code and docs first; ask only what they cannot answer.
Ask one question at a time with ask_user, offering 2-4 concrete options with your recommendation first. Stop when you could state the goal, the constraints and what is out of scope in three sentences and the user would agree.
Cover: the outcome the user observes, what must not change, the cost of a wrong guess, and how they will check it is done. Never ask what you can verify in the repo; never ask more than needed. Restate the agreed intent in one short paragraph before handing off.`,
  },
  {
    id: "planning-and-task-breakdown",
    description: "Ordered, independently verifiable plan steps with a check per step.",
    version: 1,
    body: `Turn the clarified request into an ordered plan. Each step names: files and symbols touched (path:line), the change, and a check a command can run (one test file, not the whole suite). Order by dependency; flag steps that could run in parallel.
Each step is small enough to verify alone and leaves the tree green. Say explicitly what is out of scope. List open questions; the plan is not ready while any remain.
For multi-step work call plan_write once with milestones, each with an argv check. Do not start building before the plan is approved.`,
  },
  {
    id: "lean-build",
    description: "Scope discipline: smallest complete change, explicit non-goals, stop condition.",
    version: 1,
    body: `Deliver the complete narrow outcome that fits the system; nothing beyond it.
- Write acceptance (observable) and non-goals first.
- Trace the entry point through the layers that own the invariants; reuse the existing seam, and refactor only when patching would duplicate behaviour or hide the root cause.
- No extra modes, config, providers, extensibility or polish unless acceptance needs them. A new dependency, module or setting needs a stated reason.
- Respect the project's gates (file size, function limits, layers); do not work around them.
Run the focused proof, stop when acceptance passes, and report only material omissions.`,
  },
  {
    id: "doubt-driven-development",
    description: "Cross-examine a plan or decision adversarially before it stands.",
    version: 1,
    body: `Review the artifact as an adversary with fresh context; you did not write it and are not on the author's side. Check it against the original request, not against itself.
Per step give a verdict: accept, or revise with reasons. Look for: unstated assumptions, wrong order, untestable steps, missing steps, hidden failure modes, edge cases, cost of being wrong, and scope creep.
Verify claims in the code before trusting them (cite path:line); label what you could not verify. List newly found gaps separately. Do not rewrite the plan and do not soften findings to be agreeable. A finding is closed only when it is accepted into the plan or the user waives it; you cannot waive one.`,
  },
  {
    id: "idea-refine",
    description: "Stress-test assumptions and widen options before converging.",
    version: 1,
    body: `Before converging on an approach: state the problem in one sentence, list 2-4 genuinely different options (including doing less), and for each give what it assumes, what it costs, and how it fails. Attack the favourite hardest. Pick one, say why the others lost, and name the evidence that would change the choice. Keep it to a short note.`,
  },
  {
    id: "spec-driven-development",
    description: "Convert an approved plan into a spec a low-thinking model can build without design decisions.",
    version: 1,
    body: `Per plan step write: exact files, exact symbols and signatures, exact behaviour (inputs, outputs, errors), and the exact tests — positive and negative — with the command to run each. Add acceptance criteria and the sequence of independent units.
Follow existing conventions in the touched files; cite the example you mirror (path:line). The spec is done when each step can be executed with no further design decisions. Skip the spec only if the plan already names files, symbols, tests and acceptance per step. Do not write the implementation.`,
  },
  {
    id: "incremental-implementation",
    description: "Thin verifiable slices: implement, test, confirm, then the next.",
    version: 1,
    body: `Execute one spec step at a time: make the change, run that step's test, confirm green, move on. Keep each slice small enough that a failure points at the last edit. Implement exactly what the step says; no drive-by edits or scope drift.
If a step fails, report the command and output verbatim and stop; do not improvise a fix outside an approved fix plan. Only trivial mechanical slips (typo, missing import) may be self-repaired. After the last step run the full suite and the project gates (typecheck, lint, boundaries), and report results verbatim.`,
  },
  {
    id: "debugging-and-error-recovery",
    description: "Root-cause a failure from evidence and write a fix plan a Builder can execute.",
    version: 1,
    body: `Reproduce first: get the failing command and its verbatim output. Form 2-3 hypotheses ranked by evidence, and test the cheapest discriminating one by reading code or running a probe; do not edit while diagnosing.
Separate root cause from symptom; fix at the responsible layer, not where the error surfaced. Check whether the same cause explains the other failures.
Output a fix plan in the plan format: per failure one root cause (path:line), one fix, one verification command. If the same failure survives a fix, say so and re-diagnose rather than patching again.`,
  },
  {
    id: "constraint-driven-development",
    description: "Hold the written quality bar; catch quietly lowered standards in the diff.",
    version: 1,
    body: `Judge the diff against the project's written bar (AGENTS.md rules, the gate scripts and their limits), not taste. Flag every sign of a lowered bar: new @ts-ignore / eslint-disable, skipped or deleted tests, stripped assertions, stubs, edited thresholds or baselines, widened allow-lists, gate scripts changed to pass.
Check that new code has positive and negative tests and that docs the project requires in the same change were updated. Run the gates rather than assuming (check:boundaries, check:functions, check:layers, check:cycles, check:docs, typecheck, tests). A lowered bar is a blocker unless the user waived it.`,
  },
  {
    id: "code-simplification",
    description: "Find clarity smells and removable complexity without changing behaviour.",
    version: 1,
    body: `Look for what makes the change harder to read than it must be: duplicated logic, needless indirection, dead code, deep nesting, over-long functions and files, flags that nothing sets, abstractions with one use. Name the refactoring (extract function, guard clause, inline, delete). Only propose behaviour-preserving changes; if one needs a behaviour change say so. Report each as path:line | smell | severity | refactor. Prefer deleting over adding.`,
  },
  {
    id: "findings-triage",
    description: "Standard severity and waiver format for review findings so remediation is mechanical.",
    version: 1,
    body: `Report every finding in one shape, one per line: id | path:line | category | blocker/nit | problem | fix | status.
blocker = wrong behaviour, broken gate, lowered bar, security or architecture violation; nit = style or taste. Order blockers first, group duplicates under one id, and mark evidence verified or unverified.
status is open, fixed or waived. A waiver carries the user's name-free rationale and is recorded by the runner, never decided by a model. Zero open blockers means green. Do not mix findings into narrative.`,
  },
  {
    id: "goal-check",
    description: "Verify the finished result against the original request, not just the tests.",
    version: 1,
    body: `Re-read the original request and the approved plan. For each requested outcome find the evidence it holds (path:line, command output, behaviour you ran) and mark it met, partly met or not met. Look for what is missing, not only what is wrong: an unrequested change, an unmet constraint, an unhandled case the user named, a doc left stale.
Passing tests do not prove the goal; say when a requirement has no test. You are not the Builder: do not fix, report. Output a table of outcome | evidence | verdict, then a one-line overall result for the user to confirm.`,
  },
];

# Golden Steps — Roles & Skills

Project-independent mapping of the golden build pipeline to the minimal set of roles, the abilities each role needs, and the skills assigned to each.

Skill names below are Stewart shipped skills (`modules/roles-skills/src/defaults/pipelineSkills.ts`, plus `tdd`, `code-review`, `adr`, `security-review`, `surgical-patch`, `investigate-first`, `verify-and-stop` in `skills.ts`). The pipeline ones keep the Claude Code skill ids but are condensed for Stewart (bodies <2000 chars, project gates named). Mapping the roles below onto Stewart's role set (`lead`, `code-health-reviewer`, …) is a separate task: the skills ship unbound.

Aliases: `test-driven-development` → `tdd`; `code-review-and-quality` → `code-review`; `documentation-and-adrs` → `adr`; `security-and-hardening` → `security-review`; `api-and-interface-design` → `api-design`.

## The pipeline

1. **Plan** — write a plan, ask clarifying questions. High-thinking model.
2. **Interrogate the plan** — adversarial review by a *different* high-thinking model, to surface gaps the planner's own model family is blind to.
3. **Write the spec** *(optional)* — drill into detail: what changes, which files, which tests, enough granularity that a low-thinking model can build it in logical steps. **Skip only if** the plan already names files, symbols, tests and acceptance criteria per step.
4. **Build + run tests** — implement the spec/steps, run the specified tests, then the full suite and the mechanical gates (typecheck, lint, boundaries). The runner executes the gates.
5. **Investigate failures** — root-cause each failure, write a fix plan.
6. **Interrogate the fix plan** — same adversarial review as step 2.
7. **Loop** — repeat 4–6 until the full suite and gates pass.
8. **Code-health checks** — architectural and code-quality review of the change as a whole.
9. **Remediation** — write a plan for code/architecture smells; interrogate it, build it, **re-run step 4's tests and gates**, re-check with step 8.
10. **Loop** — repeat 8–9 until review is green *and* tests are green.
11. **Goal check** — verify the result against the original request (not just tests), by a role other than the Builder.
12. **Document** — record the changes and the current architecture. Per milestone/commit where the project requires docs in the same change; this step is the final reconciliation.

**Human gates:** the user approves (a) the interrogated plan before the Builder starts, (b) any waiver (see Interrogator), (c) the goal-check result before the work is called done.

## Step → role map

| Step | Role | Model tier |
|---|---|---|
| 1. Plan | Planner | high |
| 2. Interrogate plan | Interrogator | high, **different model** from Planner |
| 3. Spec | Spec Writer | high |
| 4. Build + test | Builder (+ runner runs gates) | low |
| 5. Investigate failures | Investigator | high |
| 6. Interrogate fix plan | Interrogator | high (same role as step 2) |
| 7. Fix loop | Builder executes; Investigator plans; Interrogator reviews | per role |
| 8. Code-health checks | Reviewer | high for architecture, mid for mechanical checks |
| 9. Remediation | Investigator (plan) → Interrogator (review) → Builder (execute) → runner (tests/gates) → Reviewer (re-check) | per role |
| 10. Loop | runner | — |
| 11. Goal check | Reviewer (not the Builder, different model from Builder) | mid |
| 12. Document | Documenter | low/mid |

## Minimal roles

Seven roles. The hard constraints driving the count: the Interrogator must be a different model than the Planner; the Builder must be cheap/low-thinking; investigation and review need more judgment than building. Everything else merges onto those poles.

### 1. Planner
- **Purpose:** turn a request into a clarified, ordered implementation plan.
- **Model tier:** high thinking.
- **Abilities:** requirement elicitation (one question at a time until intent is clear), task decomposition into ordered verifiable steps, scoping (explicitly excluding out-of-scope work), step granularity so each step is independently testable.
- **Skills:**
  - `interview-me` — extract what the user actually wants before planning.
  - `planning-and-task-breakdown` — ordered, implementable tasks with parallel opportunities flagged.
  - `lean-build` — scope discipline and explicit stop conditions.
- **Input:** user request. **Output:** plan artifact: goal, constraints, ordered steps, per-step verification, open questions resolved.
- **Done when:** every step has a verification and no unresolved ambiguity remains.

### 2. Interrogator
- **Purpose:** adversarial cross-examination of any plan (initial plan, fix plan, remediation plan). Never the same model as the author of the artifact under review.
- **Model tier:** high thinking, different model family from the author.
- **Independence constraint:** declared on the role as `distinctFrom: <author role>`. If the setup has only one provider/model, the runner must warn the user visibly and fall back to the same model with a different adversarial prompt; it must not silently degrade.
- **Abilities:** fresh-context reading of a plan without author bias, hidden-failure-mode analysis, assumption enumeration, edge-case generation, cost-of-being-wrong estimation, gap identification (missing steps, wrong order, untestable steps).
- **Skills:**
  - `doubt-driven-development` — cross-examine every non-trivial decision before it stands.
  - `idea-refine` — stress-test assumptions, expand options before converging.
- **Input:** plan artifact + the original request. **Output:** verdict per step — accept / revise-with-reasons; list of newly identified gaps.
- **Done when:** every finding is either accepted into the plan or **waived by the user** (a runner may not waive; it can only record the user's waiver with its rationale and show it in the final summary).

### 3. Spec Writer
- **Purpose:** convert an interrogated plan into a build specification detailed enough that a low-thinking model cannot get lost: exact files, exact symbols, exact behavior, **and the exact tests (positive and negative) per step**.
- **Model tier:** high (spec quality is what makes the cheap Builder viable).
- **Abilities:** capability decomposition, file/symbol-level mapping of changes, interface definition, test specification, acceptance criteria per capability, sequencing independent units.
- **Skills:**
  - `spec-driven-development` — capability map + spec before code.
  - `api-and-interface-design` — stable contracts between modules.
- **Input:** interrogated plan. **Output:** spec artifact — per-step files, changes, signatures, tests, acceptance criteria.
- **Done when:** each step can be executed without further design decisions.
- **Merge note:** if minimality is pushed further, this role folds into Planner (same tier, same skills family). Kept separate because it is optional and produces a distinct artifact.

### 4. Builder
- **Purpose:** execute spec steps mechanically and run the prescribed tests.
- **Model tier:** low thinking — detail comes from the spec, not the model.
- **Abilities:** faithful step execution without scope drift, implementing the specified tests, running exact commands, reporting results verbatim, stopping at failure instead of improvising.
- **Skills:**
  - `incremental-implementation` — thin verifiable slices.
  - `test-driven-development` — implement the spec's tests red-green per step; it does not design new tests beyond the spec.
  - `verify-and-stop` — prove acceptance conditions, no scope expansion.
- **Fix-loop skill:** `surgical-patch` applies **only** when executing an Investigator's approved fix plan (narrow fix at the responsible layer). Outside an approved plan the Builder never patches; a failure goes verbatim to the Investigator. The only self-repair allowed is trivial mechanical errors (typo, missing import) that do not change behavior.
- **Input:** spec/fix-plan step. **Output:** diff + raw test output.
- **Done when:** step's verification passes.

### 5. Investigator
- **Purpose:** root-cause test failures and code-health findings, and write fix/remediation plans a Builder can execute.
- **Model tier:** high thinking — diagnosis is the hardest judgment work in the loop.
- **Abilities:** evidence-ranked hypothesizing, reproduction-first discipline, root-cause vs symptom separation, fix-plan authoring at Builder-executable granularity.
- **Skills:**
  - `investigate-first` — diagnose before editing.
  - `debugging-and-error-recovery` — systematic root-cause process.
- **Input:** verbatim failure output or findings list + relevant code. **Output:** fix plan (same artifact shape as Planner's, so the Interrogator processes it uniformly).
- **Done when:** each failure/finding has one root cause, one fix, one verification.

### 6. Reviewer
- **Purpose:** code-health gate (step 8) and final goal check (step 11).
- **Model tier:** two passes. Architecture and design fit: high. Mechanical checks against the written quality bar and the goal check: mid. The Reviewer must not run on the Builder's model.
- **Abilities:** multi-axis review (correctness, readability, architecture fit, security, test quality), smell detection (duplication, layering violations, dead code, weakened checks), blocker vs nit separation, checking the result against the original request.
- **Skills:**
  - `code-review-and-quality` — multi-axis review.
  - `constraint-driven-development` — enforce the written quality bar; catch lowered standards (`@ts-ignore`, skipped tests, stripped assertions).
  - `code-simplification` — clarity smells.
  - `security-and-hardening` — vulnerability scan of the diff.
- **Input:** full diff + test evidence (+ original request for the goal check). **Output:** findings list with severity and location, in the runner's findings format (see gaps).
- **Done when:** zero blocker findings; accepted nits are recorded as user-waived.

### 7. Documenter
- **Purpose:** record of what changed and what the architecture now is.
- **Model tier:** low/mid — the material (diff, spec, review outcome) already exists; the work is faithful synthesis.
- **Abilities:** decision-recording with rationale, as-built vs as-designed reconciliation, concise durable writing.
- **Skills:**
  - `documentation-and-adrs` — ADRs and decision records.
- **Input:** spec, diff, review findings + waivers. **Output:** change documentation + updated architecture description.
- **Timing:** runs per milestone when the project requires docs in the same change as the code; a final pass reconciles. Never only at the very end.
- **Done when:** a reader with no session context can reconstruct what was built, why, and what the system now looks like.
- **Merge note:** foldable into Builder if the count must drop; kept separate because it needs as-built reading rather than step execution.

## Orchestration (runner, not a role)

Loop control is mechanical state-machine work: dispatch step → collect artifact → branch on verdict. Giving it a model-backed role wastes tokens. The runner owns:

- artifact passing (plan, spec, failure log, findings) between roles, with a fresh context per role;
- mechanical gates: full test suite, typecheck, lint, boundary checks — run by the runner, not judged by a model;
- plan-artifact and findings validation: a machine-checkable schema (steps, verification, status; findings with severity/location/waiver) the runner enforces on every artifact — a runner feature, not a skill;
- loop exit conditions: tests + gates green; review green *and* tests green;
- loop guards: escalate to the user on oscillation (same failure twice after a fix, same plan rejected twice) **and** on budget (max iterations per loop, max tokens/cost per pipeline run);
- human gates and recorded waivers (see pipeline).

## Skill gaps (built as `findings-triage` and `goal-check`)

| Gap | Why existing skills don't cover it |
|---|---|
| **findings-triage** | Reviewer output needs a consistent severity/waive format so remediation planning is mechanical; `code-review-and-quality` reviews but doesn't standardize the handoff artifact. (The schema itself is enforced by the runner.) |
| **goal-check** | No existing skill verifies a result against the original request rather than the tests; `verify-and-stop` proves acceptance conditions already written down. |

## Model-tier summary

| Tier | Roles | Rationale |
|---|---|---|
| High thinking | Planner, Interrogator, Spec Writer, Investigator, Reviewer (architecture pass) | judgment, decomposition, adversarial reasoning, diagnosis |
| Mid | Reviewer (mechanical + goal check) | checks against a written bar |
| Low | Builder, Documenter | detail lives in the artifacts, not the model |

The economic core of the design: high-thinking tokens are spent to *produce* a detailed artifact and to have a *different* model attack it, so that everything downstream can run cheap. Each fix or remediation loop repeats that pair (Investigator + Interrogator) per iteration, which is why the loop budget in the runner matters.

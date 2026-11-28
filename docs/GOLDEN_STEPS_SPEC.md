# Golden Steps — Pipeline Specification

Detailed specification for the golden build pipeline defined in `docs/GOLDEN_STEPS_ROLES_SKILLS.md`. That document is the source of truth for the Stewart binding (roles, lifecycle, lead resolution); this document is the source of truth for pipeline mechanics: artifacts, checkpoints, health policy, loop control. Where they disagree on mechanics, file the conflict — do not silently follow either.

Contents:
1. Design principles
2. Artifacts and their contracts
3. Roles with skill assignments
4. Pipeline state machine, checkpoints and human gates
5. Test criteria per checkpoint
6. Code-health and architecture policy (refactor-first, rewrite-over-patch)
7. Loop control and tripwires
8. Acceptance criteria for the pipeline itself
9. Skill acquisition list

---

## 1. Design principles

1. **Evidence before claims.** No step is "done" because a model says so. Every checkpoint has a mechanically checkable criterion — a command, an artifact schema validation, or a counted result. (Adopted from superpowers `verification-before-completion`.)
2. **High-thinking tokens are spent exactly twice per unit of work**: once to produce a detailed artifact, once for a *different* model to attack it. Everything downstream runs on cheaper tiers.
3. **Artifacts are the interface.** Roles never see each other's session history, only the artifacts. This keeps contexts small and reviews unbiased.
4. **Independence is author-based and mechanically verified.** Adversarial review must run on a different channel/model than the artifact's *actual author* — not merely a different role id. Every artifact carries provenance; checkpoints verify it. A degradation is disclosed and user-approved, never silent.
5. **Refactor, don't patch. Rewrite, don't refactor rotten code.** Patches that work around a structural problem are forbidden; see §6.
6. **Loops must terminate or escalate.** No loop runs unbounded; tripwires force user escalation.
7. **Baselines before deltas.** No gate is evaluated without knowing its pre-change state; a red baseline can never be confused with a regression, and pre-existing rot is the user's explicit problem, not silently inherited scope.

## 2. Artifacts and their contracts

All artifacts are Markdown files with a fixed header block so the runner can validate them mechanically. The runner validates schema before passing an artifact downstream; a schema-invalid artifact is a failed step, not a bad downstream result.

**Every artifact carries a provenance header** — without it, the independence principle (§1.4) is unenforceable:

```
---
artifact: <type>
revision: <n>                (increments on every rewrite of the same artifact)
author-role: <role id>
author-model: <channel>/<model>
created: <iso timestamp>
---
```

### 2.1 `PLAN.md` — implementation plan
```
# Plan: <title>
## Goal
## Non-goals            (explicit exclusions — required, may be "none")
## Constraints
## Steps
### Step N: <name>
- Files: <paths to create/modify>
- Change: <what, at symbol level where known>
- Verify: <exact command, must exit 0>
- Depends-on: <step numbers or "none">
## Open questions      (must be empty at checkpoint C2)
```
Rules: steps are bite-sized (one concern each); every step has a `Verify` command; steps are ordered; parallelizable steps share no `Depends-on` chain. Written for an executor who has never seen the codebase — exact files, names, signatures, and tests are documented, not implied. (Format derived from superpowers `writing-plans`.)

### 2.2 `INTERROGATION.md` — adversarial review verdict
```
# Interrogation: <artifact type> @ revision <n>
## Verdict: accept | revise
## Findings
### F1 [blocker|major|minor]: <title>
- Assumption challenged / gap / failure mode: <text>
- Evidence: <file:line or reasoning>
- Required resolution: <what must change, or "user decision">
## Waived               (findings waived by the user, with the user's reason)
```
Rules: one verdict for the whole artifact; any unresolved blocker ⇒ `revise`. The reviewer receives the artifact and the *original user request*, never the author's session. The artifact-under-review's provenance header and this artifact's provenance header must name different `author-model` values — verified mechanically at C2/C6.

### 2.3 `SPEC.md` — build specification (optional step)
```
# Spec: <title>
## Capability map       (feature decomposed into independently testable capabilities)
## Per capability
### C-N: <name>
- Files: <exact paths>
- Interface: <exact signatures/contracts>
- Behavior: <observable behavior incl. error cases>
- Tests: <exact test cases: name, input, expected — positive and negative>
- Build-order: <sequence>
```
Rules: a low-thinking builder must need zero design decisions. Anything left open in SPEC is a spec defect, chargeable to the Spec Writer, not the Builder.

### 2.4 `FAILURE_REPORT.md` — verbatim failure evidence
```
# Failure report @ <step>
## Command: <exact command>
## Exit code: <n>
## Output: <verbatim, untrimmed>
## Environment notes: <only facts: versions, dirty tree, etc.>
```
Rules: verbatim output, never paraphrased. Output past the runner's configured cap (default 64 KiB) is truncated at the tail — the head and the failure-relevant tail are both kept, and the truncation itself is marked with byte counts.

### 2.5 `FIX_PLAN.md` / `REMEDIATION_PLAN.md`
Same schema as `PLAN.md`, plus:
```
## Root causes
### RC1: <failure/finding>
- Root cause: <mechanism, not symptom>
- Evidence: <how confirmed — reproduction or proof>
- Fix strategy: rewrite | refactor | patch (patch requires justification per §6.4)
```
Rules: one root cause per failure; "the test was wrong" is a valid root cause but must state why the test, not the code, is at fault. Every remediation item names its strategy explicitly — this is what makes the refactor-first policy auditable.

### 2.6 `REVIEW.md` — code-health findings
```
# Review @ <base sha>..<head sha>
## Verdict: green | not-green
## Findings
### R1 [critical|important|minor]: <title>
- Category: correctness | architecture | clarity | security | tests | standards-weakening
- Location: <file:line>
- Problem: <text>
- Remedy direction: rewrite | refactor | either
- Status: open | fixed | verified | waived   (lifecycle tracked across health-loop iterations)
## Strengths            (brief — informs what not to break)
```
Severity definitions (from superpowers code-review practice):
- **critical**: incorrect behavior, data loss, security hole, weakened test/standard — must fix before proceeding.
- **important**: architectural violation, missing error handling, significant duplication — fix before the loop closes.
- **minor**: style, naming, small smells — fix or waive.

Findings are stable across iterations: a finding's id never changes once filed; new findings in later reviews get new ids. This is what makes convergence measurable (§7) — counting only fresh review output would let a shallow review fake convergence.

### 2.7 `GOAL_CHECK.md` — outcome verification against the original request
```
# Goal check @ <final sha>
## Verdict: met | not-met | partially-met
## Outcomes
### O1: <outcome the user asked for, quoted or paraphrased from the request>
- Status: met | not-met | unverifiable
- Evidence: <command output, file:line, or behavior demonstration>
```
Rules: outcomes are derived from the original user request, not from the plan — the plan is a means, the request is the end. `unverifiable` is an honest status, never papered over: it means the pipeline produced no evidence either way, and the user decides. Any `not-met` or `unverifiable` outcome routes back to investigation as findings; it does not reach documentation.

### 2.8 `DOCS.md` delta + architecture update
Records: what changed, why (decisions + rejected alternatives), current as-built architecture, waived findings, roster degradations accepted during the run. Written for a reader with zero session context.

## 3. Roles and skill assignments

Skill ids are the shipped Stewart ids (`modules/roles-skills`): the Claude Code / superpowers names in §9 are *source material* those shipped skills were condensed from, not runtime ids. Mapping: `test-driven-development` → `tdd`; `code-review-and-quality` → `code-review`; `documentation-and-adrs` → `adr`; `security-and-hardening` → `security-review`; `api-and-interface-design` → `api-design`.

### 3.1 Planner — high tier
- Skills: `planning-and-task-breakdown`, `lean-build` (condensed from `superpowers:writing-plans` + `superpowers:brainstorming`).
- Produces: `PLAN.md`.
- The Planner does **not** elicit requirements: it is a read-only child running non-interactive. The lead asks clarifying questions (`interview-me` + `ask_user`) and hands clarified intent down.
- Contract violation if: any step lacks `Verify`, or open questions remain at handoff.

### 3.2 Interrogator — high tier, different channel/model from the artifact's author
- Skills: `doubt-driven-development`, `idea-refine`.
- Produces: `INTERROGATION.md` for any plan-class artifact (initial plan, fix plan, remediation plan).
- Contract: must read the artifact fresh — no access to the author's reasoning beyond the artifact itself. Must challenge assumptions explicitly, not just proofread.
- Independence is enforced per-artifact via provenance (`distinctFrom` the *author-model*, not a role id), with degraded-independence disclosure when no independent model is available — never silent substitution.

### 3.3 Spec Writer — high tier (optional step)
- Skills: `spec-driven-development`, `api-design`.
- Produces: `SPEC.md`.
- Gate: spec detail sufficient that Builder makes no design decisions (validated at C3/C4).

### 3.4 Builder — low tier
- Skills: `incremental-implementation`, `tdd` (reference discipline incl. testing anti-patterns, condensed from `superpowers:test-driven-development` + `superpowers:executing-plans`), `verify-and-stop`.
- Fix-loop skill: `surgical-patch` applies **only** when executing an Investigator's approved fix plan. Outside an approved plan the Builder never patches; a failure goes verbatim to the Investigator. The only self-repair allowed is trivial mechanical errors (typo, missing import) that do not change behavior.
- Consumes: `PLAN.md`/`SPEC.md`/`FIX_PLAN.md`. Produces: diff + test evidence, or `FAILURE_REPORT.md`.
- Hard contract: executes steps as written. On any deviation between plan and reality → stops and escalates; never improvises a redesign. Never weakens a test, linter, or typecheck to get green (that is a critical standards-weakening finding). **Each step lands as its own commit** — review ranges, rollback and the restructure/behavior separation (§6.3) all depend on it.

### 3.5 Investigator — high tier
- Skills: `investigate-first`, `debugging-and-error-recovery` (condensed from `superpowers:systematic-debugging`, including its tripwire: repeated failed fixes on one problem mean the problem is structural — stop fixing, review the architecture).
- Consumes: `FAILURE_REPORT.md` or findings list + relevant code. Produces: `FIX_PLAN.md`/`REMEDIATION_PLAN.md` with root causes and per-fix strategy.
- Contract: reproduction before diagnosis; root cause stated as mechanism; no fix without confirmed cause.

### 3.6 Reviewer — two passes, plus the goal check
- Model tier: architecture/design pass **high**; mechanical bar-checks and goal check **mid**. (Expressing two tiers in one role binding is a known spec gap in the Stewart binding — roles doc G1.)
- Must not run on the Builder's model (`distinctFrom` includes `builder`).
- Skills: `code-review`, `constraint-driven-development`, `code-simplification`, `security-review`, `findings-triage` (the severity/status line format remediation consumes mechanically), `goal-check` (outcome-by-outcome verification against the original request).
- Consumes: diff range (base..head sha), `PLAN.md`/`SPEC.md` as requirements reference; for the goal check, the original user request. Produces: `REVIEW.md`, `GOAL_CHECK.md`.
- Contract: reviews the diff against stated requirements, not personal taste; every finding has location, severity and remedy direction; findings ids are stable across iterations.

### 3.7 Documenter — low/mid tier
- Skills: `adr`, `docs-writing`.
- Produces: `DOCS.md` delta + architecture update. Runs per milestone where the project requires docs in the same change as code; the final pass reconciles.

### 3.8 Runner (not a role, no model)
Orchestration is mechanical: artifact validation, dispatch, checkpoint evaluation, loop counting, escalation, baseline capture. The loop-guard module (§7) is deterministic runner code, never a skill — a model can be argued out of its own tripwire. The runner also discharges the human-gate protocol (§4): it presents, records, and re-interrogates — it never approves.

In degraded rosters (missing stage owners, single-role mode) the runner still enforces every checkpoint; what degrades is *who* performs the stage, never *whether* it passes. Every degradation is disclosed at the plan-approval gate and recorded in `DOCS.md`.

## 4. Pipeline state machine, checkpoints and human gates

```
                ┌──────────────────── revise ────────────────────┐
                ▼                                                │
S0 intake+baseline ──► S1 plan ─C1─► S2 interrogate ─C2─► H1 plan approval ─► S3 spec? ─C3─► S4 build+test ─C4─┐
                                                          ▲                                        │ fail    │
                                            revise/reject │                                        ▼         │
                                                          │                                   S5 investigate │
                                            ┌─────────────┴──────────────┐                       │           │
                                            ▼                            ▼                       ▼           │
                                     S6 interrogate fix/remediation ◄─C5─ FIX_PLAN ──► fix build ─C4─► (fix loop)
                                                                                                       │
                                                          ┌────────────── all tests+gates green ───────┘
                                                          ▼
                                        S8 code-health review ─C7─► not-green ─► REMEDIATION_PLAN ─C5─► S6 ─► build ─► re-test ─► S8 (health loop)
                                                          │
                                                        green
                                                          ▼
                                        S9 goal check ─C8─► H3 goal approval ─► S10 document ─C9─► DONE
                                                          │
                                            not-met/unverifiable ─► findings ─► S5 (fix loop)
```

Human gates (runner-presented, user-decided, recorded):
- **H1 — plan approval** (after C2, before any build): shows the interrogated plan **plus the roster inventory disclosure** — missing stage owners, single-role mode, degraded independence. Rejection routes back to S1 with the user's reasons. **Any plan text changed after interrogation — including edits granted at this gate — returns to S2 for re-interrogation before build.** A revised plan approved without re-interrogation silently bypasses the adversarial step; the runner makes that ordering impossible.
- **H2 — waivers** (inline, any stage): only the user may waive a blocker/finding. The runner records stage, finding id, rationale and the approving response; waivers appear in `DOCS.md`. Waiving is never a convergence mechanism (§7).
- **H3 — goal-check approval** (after C8): the user sees `GOAL_CHECK.md` before work is called done. Rejection sends unmet outcomes to S5 as findings with the user's reason attached.

Checkpoints (all evaluated by the runner, mechanically where possible):

| # | Gate | Pass criteria |
|---|---|---|
| **C0** | Baseline captured (at S0) | Before any change: full suite + mechanical gates (typecheck, lint, boundaries) run; results recorded as baseline. A red baseline is surfaced at H1 — the user decides whether fixing pre-existing failures is in scope — it is never silently absorbed into the loop exit condition. |
| **C1** | Plan schema-valid | `PLAN.md` parses incl. provenance header; every step has Files/Change/Verify; no empty sections. |
| **C2** | Plan interrogated | `INTERROGATION.md` schema-valid, verdict `accept`; zero unresolved blockers; open questions empty; **independence verified: interrogation `author-model` ≠ plan `author-model`** — failure either blocks (independent model available) or requires the degraded-independence disclosure at H1. Any `revise` → S1, revision counter +1. |
| **C3** | Spec schema-valid (if spec step used) | `SPEC.md` parses; every capability has positive *and* negative tests with exact input/expected; build-order is a DAG. Skip-gate: if the spec step is skipped, the plan itself must pass the same granularity schema — this check *is* the skip condition, not a judgment call. |
| **C4** | Build step verified | Step `Verify` exits 0, run fresh by the runner (never trusting the builder's claim); the step landed as its own commit; the diff touches only files named in the step. **Deviation handling:** extra/missing files mean the plan no longer describes reality — the deviation returns to S2 as a plan revision (re-interrogation), it is never absorbed silently. Trivial deviations (a test helper file alongside its test) may be pre-approved as a class at H1. |
| **C5** | Fix/remediation plan sound | Schema-valid; every failure/finding mapped to exactly one root cause with evidence; strategy field present per item; no `patch` without written justification (§6.4). |
| **C6** | Fix/remediation interrogated | Same as C2 (incl. independence check) applied to the fix/remediation plan. |
| **C7** | Review sound | `REVIEW.md` schema-valid, verdict present; findings carry severity/location/status. Mechanical backstop: the runner independently runs the project's gates — a `green` verdict while any gate fails is void. |
| **C8** | Goal check sound | `GOAL_CHECK.md` schema-valid; every outcome in the original request appears exactly once with status and evidence; verdict coherent with outcome statuses (`met` requires all `met`). Zero open critical/important findings; minors fixed or user-waived. Full suite + gates green *fresh*, and no failures beyond the recorded baseline. |
| **C9** | Documentation complete | Mechanical half: every file in the final diff either appears in `DOCS.md` or is on a recorded exclusion list (generated files, lockfiles). Judgment half: decisions and rejected alternatives recorded; waivers and degradations listed. |

Checkpoint renumbering note: earlier drafts numbered the review gate C7/C8 differently; the table above is canonical.

## 5. Test criteria detail

**Baseline semantics:**
- Loop exit for tests means: full suite green **or** failures identical to the recorded baseline *and* explicitly user-accepted at H1. "Identical" means same test names and same failure signatures — a failing test that changes its failure message is a new failure.
- New tests added by the change have no baseline; they must pass, no exceptions.

**Build loop (S4):**
- After each step: step `Verify` exit 0, runner-executed.
- After all steps: full suite + mechanical gates, runner-executed — integration regressions live here, not in step verifies.

**Standards-weakening detection (runner heuristics, automatic critical findings):**
- Test-file hunks removing assertion lines or adding skip markers, unless the fix plan names that test as the defect.
- *Config-file* hunks lowering a bar: coverage thresholds, lint rule severity/disable additions, typecheck strictness flags, boundary/baseline files accepting new violations. Test files are not the only place standards live — a coverage drop in `vitest.config` weakens the suite more thoroughly than any deleted assertion.
- `@ts-ignore`/`eslint-disable`-style suppressions added in non-test source.

**Interrogation quality (S2/S6):** judgment-based, but the runner enforces structure: verdict present, findings enumerated with evidence, independence verified. Zero-finding accepts are legal but logged; two consecutive zero-finding accepts from the same model pairing trigger the rubber-stamp tripwire (§7).

**Health loop convergence:** measured on the *open findings set* (stable ids, §2.6): an iteration converges if open critical+important strictly decreases. Waivers do not decrease the count — they are user decisions, not remediation. New findings legitimately increase the count; convergence is evaluated per iteration regardless of cause, and two consecutive non-decreasing iterations hit the tripwire.

## 6. Code-health and architecture policy

### 6.1 Hierarchy of remedies, in strict preference order
1. **Rewrite** the unit (file/module/class) when it is structurally wrong.
2. **Refactor** — restructure while preserving behavior, verified by the existing test suite passing unchanged before and after the structural move, then apply the behavioral change in a separate step.
3. **Patch** — forbidden except under §6.4.

### 6.2 Rewrite triggers — rewrite rather than refactor when any of:
- The unit's interface is the problem (correcting behavior requires breaking the contract anyway).
- The unit fails two or more review categories simultaneously (e.g. correctness *and* architecture).
- The same unit has already been remediated once in this pipeline run and a finding recurs — patching a patch compounds the rot.
- The unit cannot be held in context at once (oversized, tangled) — incremental refactoring of code nobody can reason about is how patches accumulate.
- The Investigator's structural tripwire fires on it (§7: repeated failed fixes — the problem is structural by definition).

### 6.3 Refactor-first discipline
- Refactoring steps and behavior-changing steps are never mixed in one build step or one commit. A remediation item is either pure-restructure (verify: existing tests pass unchanged) or behavioral (verify: new/changed tests). This is what makes "we refactor rather than patch" enforceable rather than aspirational.
- Refactoring uses the `safe-refactor` discipline: verification brackets the structural edit.

### 6.4 Patch prohibition
A patch — a local workaround that leaves the structural problem in place (special-case `if` for one input, catch-and-ignore, defensive null-checks where the invariant should be guaranteed, a second code path duplicating the first with one line changed) — is only legal when all of:
- the fix plan explicitly justifies why rewrite/refactor is disproportionate *for this item*, and
- the Interrogator accepts the justification, and
- the patch is marked with a tracked finding so it cannot be forgotten.
Unjustified patches are automatic critical findings at review.

### 6.5 Standards-weakening is never a fix
Deleting or weakening tests, typechecks, lint rules, assertions, coverage floors or review thresholds to reach green is a critical finding against the *builder*, and the change is reverted, not waved through. The quality bar only moves by explicit user decision, recorded in the docs artifact.

### 6.6 Architectural health criteria the Reviewer applies
- Layering respected: no new dependency against the direction of the architecture; no new cycles.
- Files and units stay focused: one responsibility; size within the project's gates.
- Interfaces stable and narrow: changes to public contracts are deliberate and documented.
- No duplication introduced; shared abstractions used where they exist.
- Errors handled at the right boundary, not swallowed.
- New code tested positive *and* negative.

## 7. Loop control and tripwires (runner, deterministic)

| Tripwire | Threshold | Action |
|---|---|---|
| Same test failure after fix | 2 consecutive failures with the same signature (same test, same assertion) | Escalate to user with full history — no third automatic fix. (Tightens superpowers' 3-attempt rule for identical failures; 3 attempts applies to *evolving* failures.) |
| Fix attempts on one problem | 3 total | Mandatory architectural review: the Investigator must consider rewrite of the containing unit (§6.2), and the fix plan may not contain another patch. |
| Plan revision rejections | 2 rejections of the same plan revision line by the Interrogator | Escalate to user — Planner and Interrogator are in a disagreement loop only the user can arbitrate. |
| Health loop non-convergence | 2 consecutive iterations without decreasing open critical+important count | Escalate to user. |
| Rubber-stamp detection | 2 consecutive zero-finding interrogations from one model pairing | Notify user; suggest rotating the interrogator model. |
| Budget | max iterations per loop, max tokens/cost per run (both configured) | Hitting either escalates to the user with loop stats; the run does not silently continue or silently die. |

Loop counters are per-run, persisted in runner state, survive compaction, and are user-visible at any time.

## 8. Acceptance criteria for the pipeline itself

The pipeline is proven by dogfooding on one real, medium-sized feature:

1. **Artifact chain complete**: every artifact in §2 exists, schema-valid, provenance-headed, traceable — every plan step links to a commit, every failure to a root cause, every finding to a remediation or waiver.
2. **Checkpoint evidence**: every applicable checkpoint C0–C9 and human gate H1–H3 has a recorded pass with its mechanical evidence.
3. **Loop stats reported**: iterations per loop, tripwires fired, escalations — the pipeline must demonstrably terminate.
4. **Economic check**: token usage per role tier recorded; low-tier Builder+Documenter share visibly smaller than high-tier share; the Builder needed zero design-level corrections (no spec defects charged).
5. **Health proof**: final `REVIEW.md` green on a diff that a fresh independent review (different model again) confirms — one-time audit of the audit.
6. **Negative tests** — seed each of these in a trial run; the pipeline must catch all:
   - a weakened test (caught by the §5 heuristic or review),
   - an unjustified patch (caught at C5/C7),
   - a same-model interrogation (caught by the C2/C6 provenance check — a pipeline that cannot detect independence violation is not implementing §1.4),
   - a coverage-threshold drop in config (caught by the §5 config heuristic),
   - a plan deviation absorbed without re-interrogation (must be impossible — the runner ordering prevents it).
7. **Baseline honesty**: run once against a deliberately red baseline; the run must surface it at H1 rather than absorbing it into loop exit conditions.

## 9. Skill acquisition list (source material)

The shipped Stewart skills were condensed from these sources — `github.com/obra/superpowers`, prompt-only skills portable to any SKILL.md host. Inspect each upstream SKILL.md when revising the shipped condensations:

| Source skill | Fed into | Shipped as / assigned to |
|---|---|---|
| `writing-plans` | plan artifact format + planner discipline | Planner (also governs fix/remediation plans — one format everywhere) |
| `executing-plans` | builder execution discipline | Builder |
| `brainstorming` | requirement exploration | lead-side elicitation (`interview-me`) |
| `systematic-debugging` | root-cause process + structural tripwire | Investigator |
| `verification-before-completion` | evidence gates | all roles, enforced mechanically at checkpoints |
| `test-driven-development` | TDD discipline + anti-patterns | Builder (`tdd`) |
| `requesting-code-review` / `receiving-code-review` | severity triage, dispatch context, pushback protocol | Reviewer (`code-review` + `findings-triage`) |

Residual gaps that are runner features, not skills: the loop-guard module (§7), artifact schema validation, provenance tracking, baseline capture, and the human-gate protocol. These must be deterministic host code — none of them may be model-mediated.

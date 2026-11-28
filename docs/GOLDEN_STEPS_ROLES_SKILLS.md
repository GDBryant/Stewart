# Golden Steps — Roles & Skills

Project-independent mapping of the golden build pipeline to the minimal set of roles, the abilities each role needs, the skills assigned to each, and the lifecycle of those roles once a user can delete and repopulate them.

Skill names below are Stewart shipped skills (`modules/roles-skills/src/defaults/pipelineSkills.ts`, plus `api-design`, `tdd`, `code-review`, `adr`, `security-review`, `surgical-patch`, `investigate-first`, `verify-and-stop` and `docs-writing` in `skills.ts`). The pipeline ones keep the Claude Code skill ids but are condensed for Stewart (bodies <2000 chars, project gates named). The roles below ship as **default templates** (`planner`, `interrogator`, `spec-writer`, `builder`, `investigator`, `reviewer`, `documenter`) with these skills bound; the active lead runs them through the `golden-pipeline` skill. Shipping a template does not make a role live; the runtime roster is defined by "Live roles and lead resolution" below. The independent-agent items (`distinctFrom`, the `pickIndependent` agent pick and the `[Stewart] warning` reply prefix) are implemented in `modules/roles-skills/src/distinct.ts` and `modules/session/src/child.ts`. Pipeline mechanics — artifact contracts, checkpoints, human gates, the refactor-first health policy and loop tripwires — are specified in `docs/GOLDEN_STEPS_SPEC.md`; this document is the source of truth for the Stewart binding (roles, lifecycle, lead resolution).

Skill ids below are shipped ids verbatim — there is no runtime aliasing (`resolveSkills` matches exact ids; a name that is not a shipped id binds nothing). Claude Code names readers may recognise map to shipped ids as: `test-driven-development` → `tdd`; `code-review-and-quality` → `code-review`; `documentation-and-adrs` → `adr`; `security-and-hardening` → `security-review`; `api-and-interface-design` → `api-design`.

## Live roles and lead resolution

The shipped defaults are immutable templates. Live roles are user data: ordered rows in the effective `roles.yaml` (the user layer, plus trusted project overrides). Loading must not merge shipped role rows into the runtime roster merely because they ship. An empty roster is valid configuration and means "not set up", not corruption.

### Lifecycle contract

- **Initial state:** a fresh install has no live roles unless the setup wizard creates them. Chat does not silently seed defaults; it shows an empty state with **Run setup** and **Add defaults**. Sending a message with no enabled agent-kind role fails with that same actionable empty state.
- **Population:** population means binding agents and enabling the role. A copied default is assignment-empty but behaviorally complete: it keeps its shipped prompt, tools and skills. A manually added custom role is blank except for its id and safe schema defaults. Neither kind starts populated; the wizard is the initial population path, with later explicit user configuration still possible.
- **Add defaults:** a user-layer, idempotent copy operation. It appends shipped templates whose ids are missing, never overwrites or reorders an existing live row, and reports the ids added. Shipped templates themselves carry no agent bindings and `enabled: false` (as shipped), so copying is verbatim rather than a special transformation — anything else would silently populate the roster on the resolved lead's chain, the exact harm this rule exists to prevent. Copied rows therefore keep the default prompt, skills, tools, write paths and turn budget without becoming operational; this prevents an unpopulated roster from silently running every role on the lead's agent. The user can still enable one explicitly, but the UI must warn that an unbound role is not independently assigned.
- **Manual add:** the `+ Add` action creates a blank custom row, not a copy of a shipped template: no agent or secondary, no skills, no tools, no write paths, and `enabled: false`. This keeps custom roles distinct from default templates and makes accidental half-configured execution visible rather than silent.
- **Delete:** every listed live role has its own **Delete** button. Delete removes that row from the layer being edited; it is not a disable and it must not touch the shipped template. Deleting every role, including `lead`, is allowed. Because deleting a custom row is unrecoverable, the action is confirmed with the role id and, for an enabled or active-lead role, the resulting fallback or no-lead consequence. A reset button, if kept, is shown only for a row whose id has a shipped template; it means "restore this row's shipped template in place" and must not be a delete synonym.
- **Layer discipline:** lifecycle operations are layer-aware. Project rows are labelled as project rows and are never copied into the user file as a side effect of editing or deleting. If a user-layer delete reveals a project row with the same id, the UI says the role is still present from the project layer.
- **Ordering:** role order is semantic because it determines fallback. The roles UI must either support reordering or show the effective fallback order; silently depending on YAML order the user cannot see is not acceptable. **Add defaults** appends missing rows rather than reconstructing the shipped order around existing rows.
- **Migration:** existing user and project rows remain live and are never rewritten just to gain new shipped fields. There is no automatic backfill of missing defaults on upgrade: an empty live roster is user-owned state, and the migration cannot know whether it means fresh install, intentional minimalism, or an old install that relied on implicit defaults. The upgrade path must surface **Run setup** and **Add defaults** instead of silently changing behavior.
- **Wizard:** the wizard can start from an empty roster by treating shipped templates as in-memory candidates, not as live rows. It writes roles only on approved apply: a chosen template becomes a live enabled role with its selected agents; an unchosen new template is omitted; pre-existing custom roles are never dropped merely because they are not shipped. A blank selection for a pre-existing row disables that row explicitly. Apply requires at least one enabled agent-kind role.

### Active lead resolution

`lead` is the preferred id, not a hard-coded requirement. Only agent-kind roles are lead candidates or golden-stage owners: function-kind roles are utilities, never conversational leads, and are skipped by this algorithm. Resolve the active lead once per user turn:

1. If an enabled agent-kind role with id `lead` exists, it is the active lead.
2. Otherwise, if a `lead` row exists but is not an enabled agent-kind role, use the first enabled agent-kind row after it in the effective list. If there is none after it, use the first enabled agent-kind row overall.
3. If the `lead` row was deleted, use the first enabled agent-kind row in the effective list.
4. If no agent-kind role is enabled, there is no active lead; chat is unavailable with the empty-state explanation above.

This is the deterministic form of "use the next role": when the shipped order is intact, rule 2 is literally the next row; rule 3 covers deletion because a deleted row leaves no anchor. Effective order is live-merge order: user rows in file order, then project-only rows appended in project-file order; a project override does not move the user row it overrides.

The active lead is a position, not the literal id `lead`. Therefore:

- session events, the turn limit, the verify contract, the system prompt, plan driving, cost accounting and delegate admission use the active lead's actual id and chain;
- fallback is explicit: when the active lead is not an enabled `lead` row, chat/settings show which role is acting as lead and why, rather than letting the substitution look like normal operation;
- the delegate enum excludes the active lead's id, not hard-coded `lead`, and never includes disabled or deleted roles;
- an unbound child role inherits the active lead's chain, not the chain of a literal `lead` row;
- the active lead receives lead-only orchestration capabilities (`ask_user`, `plan_write`, `set_check`, plus `delegate` when at least one eligible delegation target — an enabled non-lead role of either kind — exists) by position, and its system prompt indexes `golden-pipeline` even when the fallback role does not bind it (`load_skill` is ambient, not lead-only: every child registry gets it), but it does **not** gain file-write tools or wider `writePaths` by implication; any writes still happen either through its own allowed tools or through a child role under that child's permissions and approvals;
- the resolved lead identity is pinned for continuity, but deletion or disablement is a revocation signal: finish at most the in-flight model turn, then pause before further side-effecting lead tools or verification escalation and ask whether to stop or resume under the newly resolved lead. Ordinary role edits apply on the next turn; a missing agent follows the normal chain failure/escalation rules.

Literal-`lead` call sites this contract replaces: `leadRole` (`modules/session/src/lead.ts`) and the `chat.ts` send guard throw instead of resolving a fallback; `roleChainIds` (`modules/roles-skills/src/chain.ts`) inherits the literal `lead` row's chain, then `agents[0]`; `child.ts` filters `id !== "lead"` for the delegate enum; `plan.ts`, `planDrive.ts`, `planOps.ts`, `runEvents.ts` and `sessionTools.ts` key events, plan approval, `ask_user` and cost accounting on `roleId: "lead"`; `settings.runTurnLimit` and the wizard's `assignAgent` (`enabled = id === "lead"`) assume the id as well — and `assignAgent` iterates only the live roster, so a truly empty roster gains no rows from it unless the wizard seeds templates first.

### Degraded rosters and compaction

Before the first delegation, the orchestrator inventories the enabled roster. It never delegates to a missing or disabled role. Deleting a role removes its independent context and model assignment; it does not remove the pipeline's quality gate. A missing pipeline stage is therefore performed inline by the active lead instead of being silently skipped, subject to that role's permissions, and the degradation is disclosed at the plan-approval gate. The only optional stage remains step 3, and only under its existing skip condition. To remove a required gate rather than reassign it, the user must explicitly waive that gate; the waiver records the stage, rationale and approving user response, and appears in the final summary.

The `golden-pipeline` skill must be roster-aware rather than a static list of shipped ids. Its first action is a roster inventory and owner selection for every logical stage: delegate to the enabled owner when present, otherwise use the active lead inline. Ownership is by explicit role id (or a future explicit stage-owner mapping); a custom role with a planner-like name or prompt must not be guessed as the Planner. Custom roles remain available for explicit delegation, but they do not silently fill a missing golden stage. In single-role mode the skill keeps the same stage order and artifacts, but replaces delegation with explicit inline stage prompts. The skill text must name this degradation so the lead does not believe independent review happened.

Independence is artifact-author based, not merely role-id based. The roster inventory records which physical role and model actually produced each artifact. If the active lead drafted a plan inline because `planner` was deleted, the interrogator must still avoid the active lead's model; deleting `planner` must not erase the constraint. The same rule applies when the active lead performs the Builder or Investigator stages. Where no independent model is available, the run continues only with the visible degraded-independence warning and user approval already required at the plan gate.

The shipped mechanism only partly delivers this: `distinctFrom`/`pickIndependent` resolve enabled *roles*, not artifact authors. A deleted or disabled `planner` row resolves to nothing in `avoidedModels`, so when the lead drafted the plan inline the interrogator avoids nothing and can run on the authoring model silently. Closing the hole needs artifact provenance: the orchestrator records `{authorRole, channel/model}` per artifact and the delegate-time pick takes the author's key as an extra avoid. Until that exists, independence for inline-authored artifacts is disclosed (config `distinctWarnings`, the reply `[Stewart] warning` prefix) rather than enforced.

If exactly one enabled agent-kind role exists, that role is the active lead and is used for every pipeline stage. In this mode:

- there is no agent-kind child that can own a pipeline stage, so stage delegation is impossible; if enabled function-kind utility roles exist, `delegate` may remain for those utilities but must never treat them as golden-stage owners, otherwise the delegate tool itself is omitted;
- the lead performs planning, interrogation, specification, building, investigation, review and documentation as one continuous role;
- adversarial/model independence is impossible, so the user sees one explicit warning at the plan gate rather than repeated warnings at every stage;
- human gates still apply; single-role mode is not a waiver machine;
- permissions are not expanded: a read-only single role can plan and review but cannot write, and must stop at the build stage with an actionable missing-permission message.

Compaction is orthogonal to roster size. The active lead compacts under exactly the same measured/estimated token-threshold rules as a full roster, keyed to the active lead agent's context window and skipped only when the engine owns context. Single-role mode makes compaction more important, not less. The compaction summary must preserve the pipeline state: current step, approved plan/spec or their durable locations, verbatim unresolved failure signatures, findings and severities, user waivers, completed delegations, and the next required action. When the runner exists it should store canonical artifacts outside the transcript; until then this summary contract is mandatory because artifacts otherwise live only in compactable conversation text.

## The pipeline

1. **Plan** — the lead asks clarifying questions (`interview-me` + `ask_user`), then the Planner drafts an ordered plan. High-thinking model.
2. **Interrogate the plan** — adversarial review by a *different* high-thinking model, to surface gaps the planner's own model family is blind to.
3. **Write the spec** *(optional)* — drill into detail: what changes, which files, which tests, enough granularity that a low-thinking model can build it in logical steps. **Skip only if** the plan already names files, symbols, tests and acceptance criteria per step; once the runner validates artifacts, this check *is* the plan passing the spec-granularity schema — until then the lead applies it by inspection.
4. **Build + run tests** — implement the spec/steps, run the specified tests, then the full suite and the mechanical gates (typecheck, lint, boundaries). The runner executes the gates.
5. **Investigate failures** — root-cause each failure, write a fix plan.
6. **Interrogate the fix plan** — same adversarial review as step 2.
7. **Loop** — repeat 4–6 until the full suite and gates pass.
8. **Code-health checks** — architectural and code-quality review of the change as a whole.
9. **Remediation** — write a plan for code/architecture smells; interrogate it, build it, **re-run step 4's tests and gates**, re-check with step 8.
10. **Loop** — repeat 8–9 until review is green *and* tests are green.
11. **Goal check** — verify the result against the original request (not just tests), by a role other than the Builder. A `not met` or `unverified` outcome becomes a findings list routed to step 5, not to step 12.
12. **Document** — record the changes and the current architecture. Per milestone/commit where the project requires docs in the same change; this step is the final reconciliation.

**Human gates:** the user approves (a) the interrogated plan, including any disclosed roster degradation, before the Builder starts — a rejection routes the plan back to step 1 with the user's reasons, and any plan text changed after interrogation, including edits granted at this gate, is re-interrogated before build (a revised plan approved without re-interrogation silently bypasses the adversarial step); (b) any waiver (see Interrogator); (c) the goal-check result before the work is called done — a rejection sends the unmet outcomes to step 5 as findings with the user's reason attached.

## Step → role map

Role names in this table are logical stage owners. In a degraded roster one physical role may own several stages; that does not satisfy the independence requirements, it only makes the unavoidable degradation explicit and user-visible.

| Step | Role | Model tier |
|---|---|---|
| 1. Plan | Planner | high |
| 2. Interrogate plan | Interrogator | high, **different channel/model** from the plan's author |
| 3. Spec | Spec Writer | high |
| 4. Build + test | Builder (+ runner runs gates) | low |
| 5. Investigate failures | Investigator | high |
| 6. Interrogate fix plan | Interrogator | high (same role as step 2; `distinctFrom` is per-artifact — different channel/model from the fix plan's author) |
| 7. Fix loop | Builder executes; Investigator plans; Interrogator reviews; runner owns iteration count, exit condition and oscillation guard (until it exists: the active lead) | per role |
| 8. Code-health checks | Reviewer | high for architecture, mid for mechanical checks |
| 9. Remediation | Investigator (plan) → Interrogator (review) → Builder (execute) → runner (tests/gates) → Reviewer (re-check) | per role |
| 10. Loop | runner (until it exists: the active lead) | — |
| 11. Goal check | Reviewer (not the Builder, different channel/model from Builder) | mid |
| 12. Document | Documenter | low/mid |

## Minimal roles

Seven roles. The hard constraints driving the count: the Interrogator must run on a different channel/model than the author of the artifact it reviews; the Builder must be cheap/low-thinking; investigation and review need more judgment than building. Everything else merges onto those poles.

### 1. Planner
- **Purpose:** turn a request into a clarified, ordered implementation plan.
- **Model tier:** high thinking.
- **Abilities:** consuming clarified intent plus the code the task concerns, task decomposition into ordered verifiable steps, scoping (explicitly excluding out-of-scope work), step granularity so each step is independently testable, surfacing residual ambiguity as open questions the lead takes back to the user.
- **Skills:**
  - `planning-and-task-breakdown` — ordered, implementable tasks with parallel opportunities flagged.
  - `lean-build` — scope discipline and explicit stop conditions.
  - (No elicitation skill: the Planner is a read-only child running `interactive: false` and cannot ask the user. The lead asks the questions — `interview-me` + `ask_user` — and hands clarified intent down.)
- **Input:** user request. **Output:** plan artifact: goal, constraints, ordered steps, per-step verification, open questions resolved.
- **Done when:** every step has a verification and no unresolved ambiguity remains.

### 2. Interrogator
- **Purpose:** adversarial cross-examination of any plan (initial plan, fix plan, remediation plan). Never the same model as the author of the artifact under review.
- **Model tier:** high thinking, different `channel/model` pair from the artifact's actual author (model *family* is not detectable — a same-family different-model binding still counts as independent).
- **Independence constraint:** declared on the role as `distinctFrom: string[]` over every role that can author an artifact it reviews (shipped: `[planner, investigator]`). Runtime enforcement is built: the first eligible chain agent not sharing a model with an enabled `distinctFrom` role's primary agent wins (`pickIndependent`); if none qualifies, the run falls back to the first chain agent with the delegate reply prefixed by the `[Stewart] warning` line, and config load emits a `distinctWarnings` line per colliding pair — degraded, never silent. The remaining hole: it keys on enabled *roles*, not the artifact's actual author — see the provenance gap under degraded rosters.
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
  - `api-design` — stable contracts between modules.
- **Input:** interrogated plan. **Output:** spec artifact — per-step files, changes, signatures, tests, acceptance criteria.
- **Done when:** each step can be executed without further design decisions.
- **Merge note:** if minimality is pushed further, this role folds into Planner (same tier, same skills family). Kept separate because it is optional and produces a distinct artifact.

### 4. Builder
- **Purpose:** execute spec steps mechanically and run the prescribed tests.
- **Model tier:** low thinking — detail comes from the spec, not the model.
- **Abilities:** faithful step execution without scope drift, implementing the specified tests, running exact commands, reporting results verbatim, stopping at failure instead of improvising.
- **Skills:**
  - `incremental-implementation` — thin verifiable slices.
  - `tdd` — implement the spec's tests red-green per step; it does not design new tests beyond the spec.
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
- **Model tier:** two passes. Architecture and design fit: high. Mechanical checks against the written quality bar and the goal check: mid. The Reviewer must not run on the Builder's model (`distinctFrom: [builder]`). Not yet expressible: a role has one binding and one `effort` override, so the shipped reviewer runs a single tier — the two-pass split is a design target (spec gap G1).
- **Abilities:** multi-axis review (correctness, readability, architecture fit, security, test quality), smell detection (duplication, layering violations, dead code, weakened checks), blocker vs nit separation, checking the result against the original request.
- **Skills:**
  - `code-review` — multi-axis review.
  - `constraint-driven-development` — enforce the written quality bar; catch lowered standards (`@ts-ignore`, skipped tests, stripped assertions).
  - `code-simplification` — clarity smells.
  - `security-review` — vulnerability scan of the diff.
  - `findings-triage` — the standard severity/status line format remediation consumes mechanically.
  - `goal-check` — outcome-by-outcome verification against the original request.
- **Input:** full diff + test evidence (+ original request for the goal check). **Output:** findings list with severity and location, in the runner's findings format (see gaps).
- **Done when:** zero blocker findings; accepted nits are recorded as user-waived.

### 7. Documenter
- **Purpose:** record of what changed and what the architecture now is.
- **Model tier:** low/mid — the material (diff, spec, review outcome) already exists; the work is faithful synthesis.
- **Abilities:** decision-recording with rationale, as-built vs as-designed reconciliation, concise durable writing.
- **Skills:**
  - `adr` — ADRs and decision records.
  - `docs-writing` — concise, command-and-path-first prose.
- **Input:** spec, diff, review findings + waivers. **Output:** change documentation + updated architecture description.
- **Timing:** runs per milestone when the project requires docs in the same change as the code; a final pass reconciles. Never only at the very end.
- **Done when:** a reader with no session context can reconstruct what was built, why, and what the system now looks like.
- **Merge note:** foldable into Builder if the count must drop; kept separate because it needs as-built reading rather than step execution.

## Orchestration (runner, not a role)

Loop control is mechanical state-machine work: dispatch step → collect artifact → branch on verdict. Giving it a model-backed role wastes tokens. Until a runner exists, the session plus the active lead share these duties; the invariants still apply. The runner owns:

- active-lead resolution once per user turn and propagation of that resolved role through session, plan driver, delegation, events and cost accounting — no hard-coded `lead` id;
- roster inventory before orchestration: enabled roles, missing stage roles, single-role mode, and independence degradation, all made visible at the plan gate;
- artifact passing (plan, spec, failure log, findings) between roles, with a fresh context per role; artifacts must remain addressable after compaction, either in a store or through the mandatory summary contract above;
- delegation eligibility: the enum contains enabled non-lead roles only, the delegate tool is omitted when there are none, and eligibility is rebuilt if the roster changes between turns;
- mechanical gates: full test suite, typecheck, lint, boundary checks — run by the runner, not judged by a model;
- plan-artifact and findings validation: a machine-checkable schema (steps, verification, status; findings with severity/location/waiver) the runner enforces on every artifact — a runner feature, not a skill;
- loop exit conditions: tests + gates green; review green *and* tests green;
- loop guards: escalate to the user on oscillation (same failure twice after a fix, same plan rejected twice) **and** on budget (max iterations per loop, max tokens/cost per pipeline run);
- human gates and recorded waivers (see pipeline).

Until the runner exists these duties map onto current machinery — and the mapping exposes the remaining gaps: artifacts are delegate reply text (the lead persists the plan via `plan_write`); mechanical verification is the milestone `check`, `set_check` and the project `verify:` commands; loop guards exist only as the `golden-pipeline` text's 'same failure twice / 3 loops' stops plus `settings.costLimit`; the delegate tool stays registered with a `_none_` sentinel enum rather than being omitted; and roster inventory, stage-owner selection, degraded-independence disclosure and artifact provenance have no implementation at all — they live in skill text and lead discipline. Closing those gaps is work this plan includes, not a prerequisite for it: the rows that currently fail are named in the table below.

### Runner acceptance checks

The runner duties above are part of this plan, not assumed infrastructure. Until every row passes the runner is not built, however much machinery exists:

| Case | Required behavior |
|---|---|
| Loop exit, fix loop | The loop ends only when the full suite and mechanical gates pass; pass/fail comes from command results, never a model's judgment. |
| Loop exit, review loop | The loop ends only when review is green *and* tests are green; either alone does not exit. |
| Oscillation guard | The same failure signature twice after a fix, or the same plan rejected twice, escalates to the user instead of a further silent retry. |
| Budget guard | Max iterations per loop and max tokens/cost per pipeline run are enforced mechanically; hitting either escalates to the user. |
| Artifact schema | A plan artifact without ordered steps and per-step verification, or findings without severity/location/waiver, is rejected before the next stage consumes it. |
| Artifact survival | After compaction the current artifact or its durable location is still addressable; pipeline state is reconstructable from the summary contract alone. |
| Delegation eligibility | The delegate enum contains enabled non-lead roles only, is rebuilt when the roster changes, and the tool is omitted — not sentinel-filled — when no eligible role exists. |
| Roster disclosure | The plan-approval gate shows the roster inventory: missing stage owners, single-role mode, independence degradation. |
| Artifact provenance | Every artifact carries its author role and channel/model; independence picks avoid the author's model even when the artifact was authored inline by the active lead. |
| Recorded waivers | Every waiver records stage, rationale and the approving user response, and appears in the final summary. |

## Lifecycle acceptance checks

| Case | Required behavior |
|---|---|
| No `roles.yaml` rows | Config loads without a parse/validation error; chat shows the empty-state action instead of throwing `role 'lead' not configured`. |
| Add defaults twice | First click appends only missing template rows; second adds nothing; existing customized rows keep their fields and relative order. |
| Manual `+ Add` | Creates a disabled blank custom row, not a default template copy; it has no agent, skills, tools or write paths until configured. |
| Delete every role one at a time | Every delete succeeds, including `lead`; the final state is the valid empty roster. |
| `lead` disabled | The next enabled agent-kind row after it becomes active lead; if none follows, the first enabled agent-kind row overall does. |
| `lead` deleted | The first enabled agent-kind row in effective order becomes active lead. |
| `lead` exists only in the project layer | The row keeps its appended position in effective order; if it is not an enabled agent-kind role, the first enabled agent-kind row overall becomes active lead. |
| Post-interrogation plan edit | Plan text changed after interrogation — including edits the user requests at the approval gate — is re-interrogated before any build step runs. |
| Goal check fails or is rejected | Unmet or unverified outcomes become findings routed to the Investigator; the run resumes in the fix loop, not at step 12. |
| Add defaults on a fresh roster | Copied rows arrive `enabled: false` and unbound (requires the shipped rows to carry `enabled: false`); nothing becomes operational until the user enables and binds one. |
| Only function-kind roles enabled | They never become lead; chat shows the no-active-lead empty state. |
| Fallback lead | Events, delegation exclusion, turn budget, chain inheritance and system prompt use the fallback role's id; the fallback is visibly labelled; it does not gain write tools or wider write paths. |
| Planner deleted, lead drafts inline | The interrogator still avoids the lead's actual model or emits the degraded-independence warning; deleting the planner row does not erase author independence. |
| Exactly one enabled agent role, no function utilities | No delegate tool is offered; all stages run through that role; the independence warning is shown once; compaction still runs at the normal thresholds. |
| One enabled agent role plus function utilities | Function utilities may be delegated as utilities, never as golden-stage owners; stage work still belongs to the single agent role. |
| Read-only single/fallback role | Planning/review can proceed, writing cannot; the run stops at the build stage with a missing-permission message instead of escalating privileges. |
| Project override present | Editing or deleting in the user layer does not copy or remove project rows; the UI explains which layer supplies the effective row. |
| Role deleted mid-run | No further side-effecting lead work starts after the in-flight turn; the user chooses to stop or resume under the newly resolved lead. |

## Skill gaps (built as `findings-triage` and `goal-check`)

| Gap | Why existing skills don't cover it |
|---|---|
| **findings-triage** | Reviewer output needs a consistent severity/waive format so remediation planning is mechanical; `code-review` reviews but doesn't standardize the handoff artifact. (The schema itself is enforced by the runner.) |
| **goal-check** | No existing skill verifies a result against the original request rather than the tests; `verify-and-stop` proves acceptance conditions already written down. |

## Model-tier summary

| Tier | Roles | Rationale |
|---|---|---|
| High thinking | Planner, Interrogator, Spec Writer, Investigator, Reviewer (architecture pass) | judgment, decomposition, adversarial reasoning, diagnosis |
| Mid | Reviewer (mechanical + goal check) | checks against a written bar |
| Low | Builder, Documenter | detail lives in the artifacts, not the model |

The economic core of the design: high-thinking tokens are spent to *produce* a detailed artifact and to have a *different* model attack it, so that everything downstream can run cheap. Each fix or remediation loop repeats that pair (Investigator + Interrogator) per iteration, which is why the loop budget in the runner matters.

The tier table describes the full-roster optimum, not a permission requirement. In single-role or otherwise degraded rosters the active lead's model necessarily serves every tier; that is a cost/quality trade-off the user approves at the plan gate, never a silent substitution.

Tiers reach the model through the role `effort` override, the bound agent's `effort`, `think: false` on no-reasoning roles and the setup assigner profiles (`wantsReasoning`, `cheap`); there is no separate tier field. Reviewer's two-pass split is not expressible this way — one binding, one effort (spec gap G1).

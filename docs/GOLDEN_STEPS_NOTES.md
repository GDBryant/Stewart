# Golden Steps — Doc-vs-Code Audit Notes

Audit of `docs/GOLDEN_STEPS_SPEC.md` (pipeline mechanics) and `docs/GOLDEN_STEPS_ROLES_SKILLS.md` (Stewart binding) against the code, 2026-11-28 at v3.1.0 (commit `017c807`). Method: every doc claim checked against source (`modules/roles-skills`, `modules/session`, `packages/core`, `packages/webview`) and tests; structural gates run (`check:layers` 19 modules, `check:boundaries` 0 violations, `check:functions` 0 offenders, `check:docs` ok). No gate rot found — all findings below are doc-vs-code gaps.

## Verified built (docs ≈ code)

- **Active-lead resolution** — `modules/roles-skills/src/activeLead.ts` implements the 4 rules verbatim; wired into `session/lead.ts`, `session/child.ts` (delegate enum excludes the active lead's id), `core/handlers/chat.ts` (send guard), `core/handlers/config.ts`; webview mirrors it (`activeLeadId`, `packages/webview/src/rolesSection.tsx`). The literal-`lead` call sites the binding doc says "this contract replaces" are gone from source.
- **Inert shipped templates** — all 11 rows in `DEFAULT_ROLES_YAML` (`defaults/roles.ts`) are `enabled: false`, unbound; the 7 golden roles ship with the doc's exact skill bindings and `distinctFrom` (`interrogator: [planner, investigator]`, `reviewer: [builder]`); all named pipeline skill ids exist in `pipelineSkills.ts`/`skills.ts`.
- **Independence mechanism** — `distinctFrom`/`pickIndependent`/`distinctWarnings` (`distinct.ts`) and the `[Stewart] warning` reply prefix (`child.ts` `independenceWarning`) are built and tested.
- **Lifecycle** — `roles.addDefaults` is an idempotent append-only copy (no-op write when nothing missing); per-row **Delete** with two-step confirm naming the fallback/no-lead consequence; empty roster is valid and chat fails with the actionable `NO_LEAD_MESSAGE`; wizard treats shipped templates as in-memory candidates (`buildAgentsForRoles`: chosen → enabled, unchosen pre-existing → disabled, unchosen templates omitted; `seededWizardIds` for `assignAgent`).
- **Delegation eligibility** — the delegate tool is *omitted* when no eligible role exists (`session.ts` `hasDelegateTargets`). This acceptance row the binding doc listed as currently failing now passes; the `_none_` sentinel in the schema is now a dead defensive branch.

## Gaps (doc demands, code missing)

1. **The runner does not exist.** No artifact store, no provenance headers, no schema validation of PLAN/INTERROGATION/REVIEW/GOAL_CHECK, no deterministic loop guards (oscillation: same failure twice / same plan rejected twice; per-loop iteration caps; per-run token/cost cap beyond the generic `costLimit`), no C0 baseline capture, no recorded human gates (H1 roster disclosure, H2 waiver record, H3 goal-check approval). All of it is lead discipline in skill text + `ask_user`. The binding doc's whole "Runner acceptance checks" table is red, and SPEC §8 (dogfood proof + the 5 negative tests) has never been executed. The docs are honest that this is planned work — but it is the single biggest delta: SPEC §1 says these "must be deterministic host code — none of them may be model-mediated".
2. **`golden-pipeline` skill is not roster-aware** (the binding doc requires it: first action = roster inventory + owner selection). `defaults/goldenPipeline.ts` is a static list — `delegate planner` … `delegate documenter`. Consequences:
   - Any disabled/deleted stage role makes `delegate` throw `unknown delegate role`; the skill has no "perform this stage inline as the active lead" fallback.
   - No degraded-independence / single-role disclosure in the skill text (doc: "The skill text must name this degradation so the lead does not believe independent review happened").
   - H1 shows "the final plan and unresolved gaps" — not the roster inventory (missing stage owners, single-role mode, degraded independence).
   - No "plan text edited by the user at the approval gate → re-interrogate before build" instruction (binding doc acceptance table).
3. **Author-based independence hole** (acknowledged in the doc, still open): `avoidedModels` keys on enabled `distinctFrom` *roles*, not artifact authors. Delete/disable `planner` and the interrogator avoids nothing — an inline-authored plan can be "independently" reviewed on the same model with no warning.
4. **Compaction summary violates the pipeline-state contract** (binding doc, "Degraded rosters and compaction"). `compact.ts` `SUMMARY_SYSTEM` is generic ("goals, files changed, commands, next steps… under 500 words") and does not preserve: current step, approved plan/spec or their durable locations, verbatim unresolved failure signatures, findings + severities, user waivers, completed delegations, next required action. "Under 500 words" actively conflicts with "verbatim failure signatures", and artifacts currently live only in compactable transcript text — a real loss path.
5. **Fallback lead is not visible** (binding doc: "chat/settings show which role is acting as lead and why"). `LeadResolution` carries `fallback` + `reason` but no UI consumes them — `activeLeadId` is used only in delete-confirm copy. No active-lead badge, no fallback label, no reorder UI, and no explicit "this order determines fallback" display in the Roles tab (list order *is* the effective order, but nothing says so).
6. **Smaller deltas:**
   - **Per-step commits** (SPEC §3.4 "Each step lands as its own commit") appear nowhere — not in the builder prompt, the skill, or the plan flow.
   - **Enabled-but-unbound role warning** (binding doc: "the UI must warn that an unbound role is not independently assigned") missing: `RoleCard` shows "no agent" (informational only); delegation of an enabled unbound role silently inherits the active lead's agent (`child.ts` `pickAgent` fallback).
   - **Chat empty state**: doc wants **Run setup** + **Add defaults** as actionable in the chat empty state; you get a failed-run message naming both (text only) and a Roles-tab hint. No buttons in the chat pane.
   - **`roleWindow.ts` `budgetOf` still keys on literal `role.id === "lead"`** (the "no hard-coded `lead` id" contract). With the `lead` row deleted and a fallback role (e.g. `planner`, turnBudget 20) acting as lead, the small-window warning is suppressed even though the actual lead run uses `settings.runTurnLimit` (default 60) — exactly the misconfiguration the warning exists for.
   - **`_none_` sentinel** (`child.ts` delegate schema) is a dead branch now that the tool is omitted when empty.
   - **Two role writers with different enable semantics**: `handleRolesAssignAgent(wizard: true)` hard-enables `id === "lead"` only (`effectiveWizardRow`), while the wizard's real apply path (`buildAgentsForRoles`) enables every chosen row. Works today; the duplication will drift.
   - **Stale sandbox build**: `.intellijPlatform/sandbox/stewart/IU-2026.1/.../sidecar.cjs` still contains the *old* literal-lead code (`role 'lead' not configured` throw, `r.id !== "lead"` delegate filter, `roleId: "lead"` events). Build artifact, not source — but it pollutes code searches and can masquerade as unfixed code. Regenerate or gitignore.
   - **Reviewer two-pass tier** (spec gap G1): one binding, one `effort` — acknowledged design target, not built.

## Unhealthy architecture (beyond the golden docs)

- **Central debt**: pipeline invariants (ordering, independence, gates, loop termination) live in model-mediated skill text while SPEC §1 demands deterministic host code. The code currently contradicts the spec it ships.
- **Duplicated state machine**: the webview hand-mirrors `resolveActiveLead` (`activeLeadId`); two implementations of the same resolution order must be kept in sync by convention only.
- Otherwise structurally clean: empty function-limits baseline, zero boundary violations, no TODO/FIXME rot in source, 19 modules in the layer manifest.

## Suggested priority

1. **Roster-aware `golden-pipeline` skill** (text-only, cheap): inventory → owner selection → inline fallback → disclosure → re-interrogate-on-edit. Closes the worst operational risk (the lead silently believes delegation and independence work).
2. **Pipeline-aware compaction summary** (or a minimal durable artifact store): add the state contract to `SUMMARY_SYSTEM` and lift the 500-word cap for pipeline runs.
3. **The runner** (the big one): artifact store + provenance + schema validation + loop guards; accept it with the SPEC §8 negative tests.
4. **Visible fallback lead + effective-order indicator** in the Roles tab.
5. Small cleanups: `roleWindow` literal `lead`, `_none_` sentinel, enabled-unbound warning, chat-pane empty-state buttons, stale sandbox bundle.

## Resolution (2026-11-28, same day)

Built: priority 1 (roster-aware `golden-pipeline` v2 — inventory, inline fallback, degradation disclosure, re-interrogate-on-edit) and item 5 small cleanups: `roleWindow` active-lead-aware budget, `_none_` sentinel removed, enabled-unbound warning in the Roles tab, chat-pane empty-state actions (Run setup / Add defaults / Open roles), stale sandbox bundle deleted. Open: priorities 2 (pipeline-aware compaction), 3 (the runner), 4 (visible fallback lead); the per-step-commit and two-writers deltas remain.

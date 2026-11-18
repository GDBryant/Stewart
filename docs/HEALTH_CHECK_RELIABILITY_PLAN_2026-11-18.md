# Health-Check Reliability Plan - 2026-11-18

Status: implemented; automated verification passed. This document is the task checklist.

## Evidence

Investigation: Stewart health check of `/srv/compose/bulkonline/addons/boxer_bulkonline/controllers/`, session `smwktguj1-r1o0`, run `run-8`, 2026-11-17.

- Log: `/home/gdb/.cache/JetBrains/PyCharm2026.3/log/stewart/debug_logs/2026-11-17.log`.
- Child transcripts: `/home/gdb/.config/JetBrains/PyCharm2026.3/stewart/f6b99089/sessions/smwktguj1-r1o0/task-*.json`.
- Report: `/srv/compose/bulkonline/.stewart/reports/health-run-8.md`.
- Six recorded subtasks failed; only `task-20` succeeded. Failures were report validation, policy denials and turn exhaustion, not six failing Odoo tests.
- The saved report scored only lines 171-330 of `main.py`; the parent run nevertheless finished `done`.

Logs contain project content. Keep raw transcripts out of commits; use minimal redacted fixtures for regression tests.

## Scope And Constraints

Fix Stewart orchestration, report delivery and evidence handling; do not modify the Odoo controllers. Preserve permission gates, workspace isolation, model-chain fallback and existing quality thresholds. Do not solve this by globally enabling shell commands, automatically trusting external paths or merely increasing turn budgets. Update `docs/ai_docs/ARCHITECTURE_NOW.md` with each implementation change to modules, run paths, protocol, configuration or host wiring.

## Tasks

### 1. Deliver the health-report contract automatically - P1

- [x] Inject the existing required health-report format into every `report: "health"` child task before its first model call; do not depend on the model choosing `load_skill`.
- [x] Keep one authoritative format shared by contract delivery and validation. Preserve it across escalation without imposing it on ordinary text reports.
- Acceptance: a worker that never loads a skill can see every required field; valid health output passes; missing or malformed fields still fail; text-mode behavior is unchanged.
- Likely files: `modules/session/src/child.ts`, `modules/session/src/lead.ts`, `modules/tasks/src/checks.ts`, `modules/roles-skills/src/defaults/skills.ts` and their tests.
- Verification: focused session delegation and task health-schema tests. Dependencies: none.

### 2. Run project checks through an execution-capable role - P1

- [x] Stop assigning test execution to the read-only reviewer. Use a permission-gated execution path with no authority to edit application source; keep review work read-only.
- [x] Return structured check results distinguishing passed, failed, policy-denied, unavailable executable and timeout. A policy denial must never become a claim that Docker is unavailable.
- Acceptance: an approved test command runs once; denial runs nothing and reports `not run` with its reason; a genuine missing executable remains distinguishable; no application write permission is added to reviewer.
- Likely files: `modules/roles-skills/src/defaults/skills.ts`, `modules/session/src/child.ts`, `modules/tools/src/policy.ts`, `modules/code-health/src/types.ts` and their tests.
- Verification: focused project-check dispatch, policy and report-rendering tests using stubbed process results, not Docker. Dependencies: task 1 for structured health output.

### 3. Report incomplete coverage honestly - P1

- [x] Track the requested inventory, delegated files/ranges and terminal task outcomes alongside accepted reports; retain failed-task reasons in the merged result.
- [x] Label partial reports explicitly in the saved report, chat and task/run presentation. Do not equate one accepted slice with a complete folder health check or a whole-file score.
- [x] Reject findings outside a declared review range unless separately identified as verified supporting evidence; avoid overwriting distinct range results solely by file path.
- Acceptance: the incident pattern produces an incomplete report naming unreviewed ranges and failed checks; complete coverage is labeled complete; failed work is not silently dropped; cancellation remains distinct.
- Likely areas: `modules/session/src/child.ts`, `modules/session/src/session.ts`, `modules/code-health/src/types.ts`, shared protocol and task UI as required. Split report aggregation and host presentation into separate patches if needed.
- Verification: focused merge/render and session tests for complete, partial, overlapping and failed ranges; task UI tests for the chosen compatible status representation. Dependencies: task 1; integrate task 2 check outcomes.

### 4. Support explicit read-only framework references - P2

- [x] Add opt-in, project-scoped read-only reference roots for framework sources such as `/srv/volumes/odoo_common/`; expose them through file/search tools without granting write or execution rights.
- [x] Validate canonical paths and symlink targets against configured roots. Unconfigured paths remain denied; policy errors identify the missing capability and a supported next action.
- [x] Prefer supported file tools to broadening the shell allowlist for `sed` or `cd`; document reference-root setup and limitations.
- Acceptance: configured framework files can be read/searched; traversal, symlink escapes, unconfigured roots and writes remain denied; ordinary workspace reads are unchanged.
- Likely areas: `modules/tools/src/projectPaths.ts`, file/search tools, configuration and host file access. Split configuration/path enforcement and host/tool wiring into separate patches.
- Verification: focused tools/configuration tests plus host file-access tests, covering positive and negative paths. Dependencies: none; shared config/host contract must be settled before implementation is parallelized.

### 5. Repair report formatting before escalating - P2

- [x] For format/schema-only failure, allow one bounded repair attempt using the existing findings, exact validation errors and required format; do not restart code exploration or rerun checks.
- [x] Escalate normally if repair fails. Do not apply format repair to permission denial, cancellation, cost limits, missing evidence or substantive check failures.
- [x] Keep recovery bounded across the task; report repair versus model escalation distinctly. Repeatedly denied capabilities should lead to an explicit limitation, not command variations that consume the turn budget.
- Acceptance: repairable JSON succeeds without another model in the chain; failed repair escalates once through the existing flow; non-format failures are not disguised; findings and check results are preserved.
- Likely files: `modules/session/src/taskRun.ts`, `modules/session/src/handover.ts`, `modules/tasks/src/checkTypes.ts` and their tests.
- Verification: focused task-runner tests with scripted model responses and assertions on model/tool call counts. Dependencies: task 1; integrate task 3 coverage state.

### 6. Separate verified findings from hypotheses - P2

- [x] Require findings to cite project-root-relative locations and distinguish directly verified behavior from framework assumptions or unavailable evidence.
- [x] Ensure the lead does not promote rejected worker output or unverified claims into confirmed findings; retain useful hypotheses separately with the missing verification named.
- [x] Use the incident's false `float("1e")`/`SyntaxError` claim as a regression scenario: Python raises the already-caught `ValueError`; it is not a confirmed controller defect.
- Acceptance: unsupported claims remain explicitly unverified; missing framework access is visible; valid citations alone are not presented as proof of behavior; supported findings survive synthesis unchanged.
- Likely areas: reviewer/lead instructions, health-report evidence representation and synthesis checks; determine the smallest enforceable contract before implementation. Automated checks cannot establish arbitrary semantic truth.
- Verification: focused report/synthesis tests with supplied verified and unverified evidence; manually reproduce language/runtime claims where appropriate. Dependencies: tasks 1 and 3; task 4 improves available evidence but is not permission to assume it exists.

## Order And Delegation

1. Implement task 1, then tasks 2 and 3; checkpoint: mandatory contract delivered, checks dispatched safely, partial coverage visible.
2. Task 4 can proceed independently after its interface is agreed. Task 5 follows task 1; task 6 follows task 3.
3. Delegate implementation and focused tests as bounded patches; serialize edits to shared files, particularly `child.ts`, `skills.ts` and `types.ts`. Keep contract design, evidence judgments and final diff review with the lead.

## Completion Gate

- [x] Each task has positive and negative regression tests; no thresholds or permission checks are weakened.
- [x] Run affected-package tests/typechecks and applicable layer, boundary, cycle, TS-reference, function and documentation gates after implementation.
- [x] Rebundle/repackage the sidecar and host according to `AGENTS.md` before IDE verification.
- [ ] With approval, repeat the original folder health check: every requested file/range and check is accounted for; incomplete work is visible; no unsupported Docker or controller claims appear.
- [x] Record verification evidence and update as-built documentation. Do not claim a complete health check solely because the lead returned a final answer.

## Verification Evidence - 2026-11-18

- `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`: passed.
- `pnpm check:layers`, `check:boundaries`, `check:cycles`, `check:tsrefs`, `check:docs`, `check:functions`: passed.
- `pnpm test:coverage`: passed.
- `./gradlew test koverVerify buildPlugin`: passed; sidecar/webview/VS Code bundles and the JetBrains plugin were rebuilt.
- The original IDE health check has not been rerun; it remains gated on approval.

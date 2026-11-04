# Fault Recovery Design

Date: 2026-11-04

## Problem

A long run on `ollama/gemma4:e4b` died with:
`re-planning budget exhausted: milestone 'Generate Accuracy Report' (4): ollama/gemma4:e4b: response truncated (length)`.

- `ToolLoop` (lines ~207-226) retries a `length` finish only by compacting context (`maxTruncationRetries = 1`); otherwise it returns `Failed("truncated")`.
- `Orchestrator` treats any failed level as a milestone failure and spends the replan budget (`maxReplans = 2`). The replan re-covers the same milestone with the same oversized output ask, so it truncates again.

## Goal

A recoverable fault must not kill the run. The orchestrator sends the fault plus minimal context to a model, asks for a way forward, splits the work into smaller chunks, and passes large intermediate output through scratch files rather than prompts.

## Scope

- Recoverable faults: finish code `truncated`, `incomplete_stream`, and level status `TurnLimit` (task too big).
- Never recoverable: auth, config, provider-unavailable, user cancel.
- Two layers (option 3): local recovery first, replan with fault context as fallback.

## Design

### 1. Fault classification
`RecoverableFault` (in `agents/FaultRecovery.kt`) built from `LevelRun` plus `lastFailureCode`. `classify(run): RecoverableFault?` returns null for non-recoverable.

### 2. Layer 1: local recovery
Invoked from `runTasksSerially` (worker level) and the executor round when a level fails with a recoverable fault.

1. **Recovery call** on the PLANNER route. Input only: fault text, task description, definition of done, scratch file paths so far. No transcript.
2. Model answers via new protocol tool `submit_recovery`: 2-5 sub-tasks, each `{description, output_file}`, plus optional `advice`.
3. Each sub-task runs as a worker with a modified brief: write full output to `output_file` (under scratch dir), reply with a summary of at most 500 chars. Handoff to dependents/next round is summary + file path.
4. Results merge into one `WorkerResult` for the original task: status `ok` or `partial`. The executor sees a normal outcome.
5. Caps: `maxRecoveryDepth = 2` (a truncating sub-task may split once more), `maxRecoveriesPerRun = 4`. Exceeding a cap or a malformed/invalid `submit_recovery` means recovery fails and the original failure proceeds to layer 2.
6. Recovery usage is added to run usage. It does not consume the replan budget.

### 3. Scratch files
`<project>/.stewart/scratch/<runId>/`, written via existing project tools (permission and redaction paths apply). Deleted on successful run completion; kept on failure for debugging. Paths logged to the debug log. `.stewart/` added to ignore hints.

### 4. Layer 2: replan fallback
When recovery fails, the milestone fails as today, but `replan` receives a `FaultNote` (code, message, what recovery attempted) and a standing instruction: keep milestones/tasks small, no single output over ~N lines, use files for large data. The final failure message names the fault and recovery attempts instead of only "re-planning budget exhausted".

### 5. UI
New `OrchestratorListener.onRecovering(reason: String, depth: Int)` (default no-op). Chat shows "Output limit hit, splitting task…".

### 6. Limits
Added to `OrchestratorLimits`: `maxRecoveryDepth = 2`, `maxRecoveriesPerRun = 4`, `maxSubTasks = 5`, `recoverySummaryChars = 500`.

## Files
- New: `agents/FaultRecovery.kt`, `docs/FAULT_RECOVERY.md`
- Edit: `agents/Orchestrator.kt`, `Protocol`/`ProtocolTools` (add `submit_recovery`), `OrchestratorListener` and its UI implementation, `docs/PLAN.md`, `docs/PROGRESS.md`, `AGENTS.md` (reference the new doc)

## Testing (positive and negative; `koverVerify` must pass)
- Truncated worker leads to recovery, sub-tasks run, results merge to one `WorkerResult`.
- Executor-level truncation recovers.
- Non-recoverable fault is not intercepted.
- Depth cap and per-run cap enforced; fall through to replan.
- Malformed `submit_recovery` (0 or >5 sub-tasks, missing output_file) falls through to replan.
- Recovery usage counted; replan budget not consumed by recovery.
- Scratch dir deleted on success, retained on failure.
- `replan` receives `FaultNote` and the size instruction.
- Final failure message includes fault and recovery attempts.
- Cancellation during recovery propagates `RunCancelledException`.

## Decisions
- Recovery model is the PLANNER route (not the failed worker model).
- Scratch files deleted on success, kept on failure.

## Out of scope
- Parallel sub-task execution, cross-run resume from scratch files, changes to provider streaming code.

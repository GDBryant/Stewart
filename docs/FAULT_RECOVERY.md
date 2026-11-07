# Fault recovery

Status: **ported to the v2 TS core** (`packages/core/src/orchestration/{faults,recovery}.ts`). Spec: `docs/archived_v2/2026-11-04-fault-recovery-design.md` (v1 Kotlin; `.kt` paths there no longer exist). Unblocks budget M6 escalation (`docs/BUDGETS_AND_SETUP_INFO.md` B4).

Recovers worker and level faults before the run fails.

## Fault kinds

- `truncated`: model reply cut off (`LoopResult.failed.code = "truncated"`).
- `incomplete_stream`: stream ended early (`"incomplete_stream"`).
- `turn_limit`: level hit its tool-turn budget.

`context_limit` (a `failed` code, not a recoverable fault): context over `maxContextChars` (derived from the model's context window, max 400k chars) after every compaction stage. Stages in order: prune stale tool results (60%), summarize via the `compactor` role (80%), emergency clip; each reports a `compaction` event with before/after tokens, `pruned` and `summarized`. Full transcript stays in the journal.

`classifyFault()` (`faults.ts`) maps a `LoopResult` to a fault; completed and other failures return undefined.

## Layers

- **Layer 0, retry:** one retry of `incomplete_stream` at any level. Read-only level roles (`isWriteCapableRole` false) and the orchestrator loop retry `truncated`/`turn_limit` once with `SIZE_HINT` appended to the briefing. Workers do not retry size faults; they go to the continue question or layer 1.
- **Layer 1, split:** a faulted write-capable task is split by a `submit_recovery`-only call on the orchestrator's agent (the "brain"); sub-tasks run serially, each writing `output_file` under the task scratch dir, then code joins them into `final_file`. Nests to `maxRecoveryDepth`; skipped when the run's budget profile has `allowSplit: false`.
- **Layer 2, re-plan:** not ported — the v2 orchestrator already re-plans on `submit_verdict: revise`; no `FaultNote` is attached.

## Continue question

Asked when a worker hits its turn limit (`askOnTurnLimit`, plain chat too). Shows done-so-far, last action and a "looks stuck" hint from `detectStuck` (same call 3+, or 5 turns without a successful edit/write/terminal call).

Options, recommended first:
- `Continue (+N turns)`: extra turns for this task (`maxContinuations` per task). The loop resumes on the full transcript with an idempotency offset.
- `Split into smaller tasks`: layer 1 (only when a split is possible).
- `Stop this task`.

Split comes first when stuck. A timeout (`continueQuestionTimeoutMinutes`, 0 = wait forever), a run cancel, or a question that can't be asked (setting off, caps reached) goes to Split if possible, else stops. Timeouts/cancels emit `question.withdrawn` so the card is cleared. Free text is passed to the worker as a user message and continues. Plain chat offers Continue and Stop only; timeout stops. Plain chat is a single-task run (`RunManager.driveDirect` → `runRoleTask`); the question is asked there, and the run's time cap, cost cap and cancel behave as for orchestrated runs. Direct runs are not journaled, so they are not resumable after a restart.

## Resume

Direct runs are journaled like orchestrated ones (`run.json` with a single `direct` task + `agentId`). `/resume` replays the original request only (no chat history) on the journaled agent; executed tool calls are skipped via the idempotency log. A run hitting `maxRunHours` or the cost cap ends `interrupted` and is resumable.

## Scratch dir

- Location: `<project>/.stewart/scratch/<runId>/task-<taskId>/` (inside the workspace; `ProjectPaths` denies `.stewart/` except `scratch/`).
- Writes inside a task's scratch dir are auto-approved (`scratchGate`); the sub-task role clone gets `<taskDir>/**` added to `writePaths` (`roleWithScratch`). `final_file` uses normal approval.
- Lifecycle: output files are deleted on success; kept on failure or cancel and named in the summary (`scratch: <path>`).
- Retention: **not pruned** — v1's retention pass was not ported; kept dirs accumulate until manual cleanup.

## Settings (settings.yaml)

| Setting | Default | Notes |
|---|---|---|
| `maxWorkerTurnsCeiling` | 60 | clamped on use |
| `askOnTurnLimit` | true | show the continue question |
| `continueQuestionTimeoutMinutes` | 5 | 0 = no timeout |
| `maxRecoveryDepth` | 2 | split nesting depth |
| `maxRecoveriesPerRun` | 4 | layer-0 retries + layer-1 recovery calls |
| `maxSubTasks` | 5 | sub-tasks per split (min 2) |
| `recoverySummaryChars` | 500 | sub-task summary length |
| `maxActionsInRecoveryBrief` | 20 | actions listed in the recovery brief |
| `maxContinuations` | 2 | per task |
| `maxContinueQuestionsPerRun` | 4 | per run |
| `compaction.prune` | false | stub stale tool results (workers, direct runs, orchestrator) |
| `compaction.summarize` | false | summarize middle via an enabled `compactor` role; metered under role `compactor` |

## Logs

- Recovery lines go to `host.log`, prefixed `[run <runId>]` (v1 `recovery` category equivalent), e.g. `layer 1: turn_limit on task t1 -> 3 sub-tasks`, `continue question on t1: continue`.

## Code

- `orchestration/faults.ts`: `classify`, `detectStuck`, `actionsSoFar`, `countToolCalls` (pure).
- `orchestration/recovery.ts`: `RecoveryState`/`recoveryState`/`ensureRecovery`, `SIZE_HINT`, `taskScratchDir`, `scratchGate`, `roleWithScratch`, `parseRecoveryArgs`, `continueQuestion`, `recoveryBrain`, `runTaskRecoverable`, split + assembly.
- `orchestration/roleRunner.ts`: `deps.history`/`idemOffset`/`extraBriefing`/`approve`, `TaskResult.fault`/`transcript`/`turnBudget`.
- `orchestration/orchestrator.ts`: orchestrator-level layer-0 retry; tasks run via `runTaskRecoverable`.
- `runManager.ts`: `askTimed` (timeout + `question.withdrawn`), plain-chat continue question in `drive`, `rt.recovery`/`askTimed` wiring.
- `protocol`: `question.withdrawn` event; webview clears the pending card.

## v1 items intentionally not ported

- Layer-2 `FaultNote` on re-plans and the `SIZE_RULE` re-plan prompt (constant kept, unused).
- `submit_tasks` `max_turns` / `submit_plan` `turn_budget` hints — those verbs don't exist in v2.
- `num_ctx` settings map — v2 uses `modelCaps[model].numCtx` in `channels.yaml`.
- Scratch retention pruning.
- `onRecovering` status-line event (host.log only).

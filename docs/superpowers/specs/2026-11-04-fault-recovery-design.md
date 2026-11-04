# Fault Recovery Design

Date: 2026-11-04

## Problem

A long run on `ollama/gemma4:e4b` died with:
`re-planning budget exhausted: milestone 'Generate Accuracy Report' (4): ollama/gemma4:e4b: response truncated (length)`.

- **Truncation handling.** `ToolLoop` (`tools/ToolLoop.kt` ~207-226) handles a `length` finish by compacting once (`maxTruncationRetries = 1`). After that it returns `Failed(code = "truncated")`.
- **Failed worker.** `Orchestrator.runTasksSerially` turns the failure into `WorkerResult(failed, "no result submitted: …")`.
- **Failed executor.** A truncated executor level calls `milestoneFailed`, which spends the replan budget (`maxReplans = 2`). The replan covers the same milestone with the same oversized output, so it truncates again.
- **Ollama context window.** `OllamaProvider` sends no `options`, so Ollama's default `num_ctx` applies. The system prompt, tool specs and history together can overflow it, and Ollama then reports `done_reason: length`.
- **Turn limits.** Every orchestrator level has the same fixed budget, `maxLevelModelTurns = 15`. A large task cannot get more turns. Reaching the limit is a dead end, and the worker's progress is thrown away.

## Goal

A recoverable fault should not end the run.
- Fix the most likely cause first (Ollama context window per model).
- Then try cheap retries.
- Let large tasks have larger turn budgets.
- When a worker runs out of turns, ask the user whether to continue, split or stop. Give the user a short summary of the task to decide from.
- Otherwise, ask a model for a smaller breakdown of the work, and pass large intermediate output through scratch files rather than prompts.

## Scope

- **Recoverable faults:**
  - code `truncated`
  - code `incomplete_stream`
  - `LevelStatus.TurnLimit`
- **Never recoverable:**
  - auth
  - config
  - provider-unavailable
  - `protocol_error`
  - `invalid_upstream_response`
  - user cancel
- **Covered levels:**
  - Worker: continue, or split.
  - Executor and Planner: retry with a size hint. Covers the initial plan and re-plans.
- **Layers:**
  - Layer 0: cheap retry, or asking the user to continue.
  - Layer 1: worker split.
  - Layer 2: re-plan with fault context.

## Design

### 0. Prerequisites

#### 0a. Ollama `num_ctx` per model (ships in this change)
- **Setting.** Add `StewartSettings.ollamaNumCtx: Map<String, String>`, entered as `model=num_ctx` lines. It reuses the text-area and parse pattern of `toolPathOverrides` in `StewartConfigurable`.
  - Label: "Ollama context window (model=tokens)".
  - Validation: a positive integer between 512 and 1,048,576. Invalid lines block Apply with an error, matching the existing overrides.
  - Keys use the same form as `toolPathOverrides`.
- **Request.** `OllamaProvider` builds `"options": {"num_ctx": N}` only when the model has an entry. Without an entry the request is unchanged.
- **Debug log.** Each Ollama request logs `num_ctx` (or `default`). A `truncated` failure logs the prompt token count with it.
- **Docs.** `docs/COMPATIBILITY.md` gets a note on how `num_ctx` relates to VRAM.

#### 0b. Failure code on the level
- Change `LevelStatus.Failed(message)` to `Failed(message, code: String?)`.
- `lastFailureCode` is reset at the start of every `runLevel`, so it can't be trusted once later levels have run. `classify` reads the code from `LevelRun` instead.

#### 0c. Run id
- There is none yet. `Orchestrator.run` creates `runId = yyyyMMdd-HHmmss-<4 hex>`.
- Every recovery debug-log line includes it, and the scratch path uses it.

#### 0d. Adjustable turn budgets
- **Per task.** `submit_tasks` takes an optional `max_turns` (integer) on each task. The Executor sets it for tasks it expects to be large; the Executor prompt says so. `DispatchTask.maxTurns: Int?`.
- **Per milestone.** `submit_plan` takes an optional `turn_budget` on each milestone. It is a hint shown to the Executor ("suggested worker turns: N") and the default for tasks without `max_turns`. `Milestone.turnBudget: Int?`.
- **Resolution.** A worker gets `min(task.maxTurns ?: milestone.turnBudget ?: maxLevelModelTurns, maxWorkerTurnsCeiling)`.
  - The ceiling is a setting: default 60, range 5–200.
  - Values below 1 or above the ceiling are rejected as tool errors, so the model can resubmit.
- **Other levels.** Executor and Planner levels keep `maxLevelModelTurns`.

### 1. Fault classification
In `agents/FaultRecovery.kt`:
- `enum FaultKind { TRUNCATED, INCOMPLETE_STREAM, TURN_LIMIT }`
- `data class RecoverableFault(kind, role, message)`
- `classify(run: LevelRun): RecoverableFault?` returns null for every non-recoverable case, including `Completed`.

### 2. Layer 0: cheap retry and ask to continue

#### 2a. Transient and size faults
- **`INCOMPLETE_STREAM`, any level.** Retry the level once with the same input. If it fails again, the next layer applies.
- **Executor or Planner `TRUNCATED` / `TURN_LIMIT`.** Retry the level once, adding a size hint to the user content: "Your previous reply hit the output limit. Submit at most ⌈n/2⌉ tasks (or milestones), keep each description under 300 chars, and put large data in files." These levels have no project tools, so they are never split. If the retry fails, go to layer 2.

#### 2b. Worker `TURN_LIMIT`: ask to continue
When a worker runs out of turns, the orchestrator decides as follows:

1. **Can it ask?** It asks only when all of these hold:
   - a `UserPrompter` is available
   - `askOnTurnLimit` is on (setting, default on)
   - this task has used fewer than `maxContinuations` extensions
   - the run has used fewer than `maxContinueQuestionsPerRun` questions

   If any of these fails, it goes straight to layer 1 (split).
2. **Stuck check.** A pure function over the worker's messages. The worker counts as stuck when either holds:
   - the same tool name with identical arguments appears 3 or more times, or
   - the last 5 turns contain no successful edit, write or terminal call.

   The result sets which option is marked as recommended. It never blocks the question.
3. **Question.** Sent through `UserPrompter.ask`, with a separate counter from the Planner's `maxQuestions`. `listener.onQuestion` shows it as clickable options. The context is capped at about 600 chars:
   > Worker hit its turn limit (N) on task <id>: "<description, ≤120 chars>".
   > Done so far: <up to 5 successful actions: tool + path/command>. Last action: <tool + arg>.
   > [Looks stuck: <reason>]  ← only if detected
   >
   > Options: **Continue (+N turns)** · **Split into smaller tasks** · **Stop this task**

   The first option is the recommended one: Continue when the worker isn't stuck, Split when it is.
4. **Answers.**
   - **Continue:** call `ToolLoop.run` again with `history = TurnLimitReached.base + messages` and the same tools, with another `N` turns. The history is valid: every call already has its result. The worker keeps its progress, and auto-compaction still applies.
   - **Split:** layer 1.
   - **Stop:** `WorkerResult(failed, "stopped by user at turn limit")`. This is today's behaviour.
   - **Free text:** an answer that doesn't match an option is passed to the worker as a user message, and the run continues as for Continue.
5. **Timeout.** `continueQuestionTimeout` (setting, default 5 min, 0 = wait forever) wraps the wait. On timeout the question is withdrawn: `listener.onQuestionWithdrawn()` (new, default no-op) clears the pending UI. Then layer 1 runs.
6. **Plain chat.** The same question replaces "Stopped: tool-turn limit reached (25)" in `ChatSession`. It offers Continue and Stop only; there is no split outside orchestration. The stuck check and timeout apply. On timeout, it stops as it does today.

Layer-0 retries count toward `maxRecoveriesPerRun`. Continuations are counted separately, as `maxContinuations`. Neither uses up the replan budget.

### 3. Layer 1: worker split
Called in `runTasksSerially` when a worker fault is `TRUNCATED`, or `TURN_LIMIT` that was not continued (2b).

1. **Recovery call.**
   - Route: PLANNER.
   - Tools: a new `submit_recovery` tool only. No project tools, no ask tool.
   - Input:
     - fault kind and message
     - task description and milestone definition of done
     - **actions so far**: successful tool calls as tool name plus path or command, capped at `maxActionsInRecoveryBrief`. Files may already have been written, so sub-tasks must not blindly redo or undo them.
     - existing scratch files for this task
     - no transcript
2. **`submit_recovery` arguments.**
   - Shape: `{"subtasks": [{"description", "output_file", "max_turns"?}], "final_file"?: "<project path>", "advice"?: "…"}`.
   - 2 to `maxSubTasks` sub-tasks.
   - `output_file` is a bare file name, resolved under the task's scratch dir. Path separators and `..` are rejected.
   - `max_turns` follows the same rules as 0d.
   - Validation errors come back as tool errors, so the model can resubmit.
3. **Sub-tasks.** They run serially as workers. Each brief adds:
   - "Write your full output to `<scratch>/<output_file>` with WriteFile. Then call `submit_result` with `task_id = <parent id>` and a summary of at most `recoverySummaryChars`."
   - the summaries and file paths of the earlier sub-tasks
   - `advice`, if given

   A sub-task fault goes through layers 0b and 1 again (depth + 1) while the caps allow it.
4. **Assembly.** When `final_file` is set and every sub-task is `done`:
   - Kotlin code, not a model, joins the `output_file`s in order and writes the result to `final_file`.
   - The write goes through the normal edit path, so approval applies.
   - This avoids the single huge `WriteFile` call that truncates.
5. **Merge.** The sub-tasks become one `WorkerResult(parent.id, status, summary)`.
   - Status is `done` only if every sub-task is `done`, otherwise `failed`. These are the only statuses `parseResult` allows.
   - The summary lists each sub-task's summary and file, plus `final_file`, bounded by `maxHandoffChars`.
6. **Failure.** Any of these means recovery has failed:
   - a cap is exceeded
   - the recovery call fails or truncates
   - no valid `submit_recovery` is submitted within the turn limit
   - assembly fails

   Then the original `failed` result is recorded with a `recovery:` note. This is today's behaviour: the executor may retry the task or fail the milestone, which leads to layer 2.
7. **Usage.** Usage from recovery calls, continuations and sub-tasks goes into the usage that `runTasksSerially` returns. `runLevel` already adds it to `runUsage`.

### 4. Scratch files
- **Path:** `<project>/.stewart/scratch/<runId>/task-<milestoneId>-<taskId>/`.
- **Writes** go through the existing project tools, so path resolution, debug logging and redaction still apply.
- **Approval:** writes and creates inside the current run's scratch dir are approved automatically. The rule covers only that exact directory and is logged at debug level. Writes to `final_file` keep normal approval.
- **Lifetime:**
  - Completed run: deleted. Anything the user needs has already been assembled into `final_file`.
  - Failed or cancelled run: kept, and the path appears in the failure message.
  - Kept dirs older than the debug-log retention period are deleted by the existing prune.
- **Ignore hints:** `.stewart/` is suggested for VCS ignore and excluded from `FindFiles` and `Search`.

### 5. Layer 2: re-plan with fault context
- **Fault note.** `milestoneFailed` and `replan` take an optional `FaultNote(kind, message, recoveryAttempts: List<String>)`.
- **Prompt.** The re-plan prompt adds the note and a standing rule, kept as a constant in `Protocol`: "Keep milestones and tasks small. No single reply or file write should exceed ~150 lines; split larger output across files. Set turn_budget for milestones that need many tool steps."
- **Exhausted budget.** The failure message reads `re-planning budget exhausted: <reason>; fault: <kind> (<message>); recovery: <attempts>; scratch: <path>`.

### 6. UI and logging
- **Status lines.** New `OrchestratorListener.onRecovering(kind: FaultKind, detail: String, depth: Int)`, default no-op. `ChatSession` shows one of:
  - "Output limit hit, splitting task…"
  - "Turn limit hit, splitting task…"
  - "Stream dropped, retrying…"
  - "Continuing task (+N turns)…"
- **Turn-limit question.** Reuses `onQuestion` and the existing option buttons. Add `onQuestionWithdrawn()` for timeouts.
- **Debug log.** Every recovery decision is written with `runId`: fault, layer, user answer or timeout, sub-task count, files, outcome.

### 7. Limits and settings

**`OrchestratorLimits`:**

| Limit | Default | Meaning |
|---|---|---|
| `maxRecoveryDepth` | 2 | how deep splits can nest |
| `maxRecoveriesPerRun` | 4 | layer-0 retries plus layer-1 recovery calls |
| `maxSubTasks` | 5 | sub-tasks per split |
| `recoverySummaryChars` | 500 | sub-task summary length |
| `maxActionsInRecoveryBrief` | 20 | actions listed in the recovery brief |
| `maxContinuations` | 2 | per task |
| `maxContinueQuestionsPerRun` | 4 | turn-limit questions per run |
| `maxWorkerTurnsCeiling` | 60 | from settings |

**`StewartSettings`:**

| Setting | Default |
|---|---|
| `ollamaNumCtx` (map) | empty |
| `maxWorkerTurnsCeiling` | 60 |
| `askOnTurnLimit` | true |
| `continueQuestionTimeoutMinutes` | 5 |

The worst case for worker runs is about `maxRecoveriesPerRun × maxSubTasks + maxContinuations × tasks`. Every term is bounded.

## Files
- **New:**
  - `agents/FaultRecovery.kt`: classify, stuck check, continue question, recovery brief, `submit_recovery` parser, merge, assembly
  - `docs/FAULT_RECOVERY.md`
- **Edit:**
  - `agents/Orchestrator.kt`: `LevelStatus.Failed.code`, `runId`, hooks in `runTasksSerially`, the executor round and the planner/replan levels, `FaultNote`, resolving per-task turns
  - `Protocol` and `ProtocolTools`: `submit_recovery`, `max_turns` and `turn_budget` fields with their parsers, size hint, size rule, prompt text
  - `agents/WorkerBriefing.kt`: sub-task brief
  - `OrchestratorListener` and `ChatSession`: `onRecovering`, `onQuestionWithdrawn`, plain-chat continue question
  - `ui/ChatPanel.kt`: handle the withdrawn question
  - `tools/permissions`: scratch-dir auto-approval
  - `provider/ollama/OllamaProvider.kt`: `options.num_ctx`
  - `settings/StewartSettings.kt` and `StewartConfigurable.kt`: new settings and validation
  - Docs: `PLAN.md`, `PROGRESS.md`, `PERMISSIONS.md` (scratch rule), `COMPATIBILITY.md` (`num_ctx`), `DEBUG_LOGGING.md` (new log lines)
  - `AGENTS.md`: reference to the new doc

## Testing (positive and negative; `koverVerify` must pass)

**`num_ctx`:**
- `options.num_ctx` is sent for a model with an entry and left out without one.
- Parse rejects non-integers and values out of range.
- The settings round-trip and `isModified` works.

**Classification:** each recoverable kind maps correctly; auth, config, protocol, upstream and `Completed` give null.

**Turn budgets:**
- `max_turns` and `turn_budget` are parsed. Values below 1 or above the ceiling are rejected.
- Resolution order: task, then milestone, then default, capped by the ceiling.
- A worker loop gets the resolved `maxModelTurns`.

**Layer 0:**
- `incomplete_stream`: one retry that succeeds; a second drop goes on to the next layer.
- Truncated executor: retried with the size hint and succeeds; a second truncation leads to re-plan.
- Planner: the same as the executor.

**Continue question:**
- *Stuck check:* repeated identical call gives stuck; no progress in 5 turns gives stuck; normal progress gives not stuck.
- *Question:* context capped at about 600 chars; recommended option follows the stuck result.
- *Continue:* the loop resumes with the earlier history, gets N more turns, and can then submit a result.
- *Split* goes to layer 1. *Stop* gives a failed result. *Free text* is passed to the worker as a user message.
- *When it doesn't ask:* `maxContinuations` reached, `maxContinueQuestionsPerRun` reached, `askOnTurnLimit` off, or no prompter. Each goes straight to split.
- *Timeout* withdraws the question and splits. Timeout 0 waits.
- Continue questions don't use the Planner's `maxQuestions`.
- *Plain chat:* Continue resumes; Stop and timeout behave as today.

**Layer 1:**
- A truncated worker triggers recovery. Sub-tasks run in order with earlier summaries in their briefs and merge into one `done` result. A failed sub-task gives a merged `failed` result.
- The recovery brief contains actions so far and no transcript.
- `submit_recovery` validation: 0, 1 and more than 5 sub-tasks; missing `output_file`; `/` or `..` in it; `max_turns` above the ceiling. Each is rejected and can be resubmitted. No valid submission counts as recovery failure.
- Assembly: joins files in order into `final_file`; skipped if any sub-task failed; an assembly error counts as recovery failure.
- Depth and per-run caps are enforced and fall through to the original failure, then re-plan.

**Accounting:** recovery and continuation usage are counted in run usage; the replan budget is unchanged.

**Scratch:**
- Auto-approval applies only inside the current run's dir. Writes outside it, including `final_file`, still ask.
- The dir is deleted on completion and kept on failure or cancel, with its path in the message.

**Layer 2:** `replan` gets the `FaultNote` and the size rule. The final failure message contains the fault, the attempts and the scratch path.

**Cancellation:** cancelling during a recovery call, a sub-task, a continuation or a pending continue question raises `RunCancelledException` with the partial transcript and usage.

## Decisions
- `num_ctx` is set per model in settings and ships in this change.
- Workers that hit the turn limit can be continued (the user is asked) or split (automatic fallback).
- The Executor sets turn budgets per task and the Planner per milestone. A ceiling in settings caps both.
- The recovery model is the PLANNER route, not the failed worker's model.
- Executor and Planner levels are retried with a size hint; only workers are split.
- Kotlin code does the assembly, not a model.
- Merged status is `done` or `failed`; there is no `partial` status.
- Scratch files are deleted on success and kept on failure or cancel.

## Out of scope
- Running sub-tasks in parallel
- Resuming a later run from scratch files
- Changes to provider streaming code
- Raising `maxTruncationRetries`
- Detecting the Ollama model's maximum context automatically (`/api/show`)

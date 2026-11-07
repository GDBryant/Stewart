# Fault recovery

Recovers worker and level faults before the run fails. Spec: `docs/archived_v2/2026-11-04-fault-recovery-design.md`.

## Fault kinds

- `TRUNCATED`: model reply cut off (`Failed.code = "truncated"`).
- `INCOMPLETE_STREAM`: stream ended early (`"incomplete_stream"`).
- `TURN_LIMIT`: level hit its tool-turn budget.

`classify()` (FaultRecovery.kt) maps a finished level to a fault; completed and other failures return null.

## Layers

- **Layer 0, retry:** one retry of `INCOMPLETE_STREAM` at any level; size faults (`TRUNCATED`/`TURN_LIMIT`) retried at Planner/Executor with a size hint. Workers go to layer 1 or the continue question instead.
- **Layer 1, split:** a faulted worker task becomes up to `maxSubTasks` sub-tasks, each with its own output file, then the outputs are joined (SplitRecovery.kt). Nests to `maxRecoveryDepth`.
- **Layer 2, re-plan:** the existing re-plan path, with `SIZE_RULE` added to the prompt (Orchestrator.kt).

## Continue question

Asked when a worker hits its turn limit (`askOnTurnLimit`, plain chat too). Shows done-so-far, last action and a "looks stuck" hint from `detectStuck`.

Options, recommended first:
- `Continue (+N turns)`: extra turns for this task (`maxContinuations` per task).
- `Split into smaller tasks`: layer 1.
- `Stop this task`.

Split comes first when stuck, and is offered only when a split is possible (scratch available, depth and budget left). A timeout (`continueQuestionTimeoutMinutes`, 0 = wait forever), or a question that can't be asked (no prompter, setting off, caps reached), goes to Split if possible, else stops. Plain chat offers Continue and Stop only.

## Scratch dir

- Location: `<project>/.stewart/scratch/<runId>/task-<milestoneId>-<taskId>/`. Used by layer-1 splits only.
- Lifecycle: created at split; deleted on success; kept on failure or cancel and named in the failure message. A completed run deletes its whole run dir.
- Retention: pruned by the debug-log retention setting, skipping the current run.
- Auto-approve: `ScratchApprovalGate` approves `WriteFile`/`EditFile` strictly inside a registered task dir of the current run. Everything else uses normal approval. See `docs/PERMISSIONS.md`.

## Settings (StewartSettings)

| Setting | Default | Notes |
|---|---|---|
| `ollamaNumCtx` | empty map | per model, `ollama/<model>` = decimal; range 512..1048576 |
| `maxWorkerTurnsCeiling` | 60 | clamped on use |
| `askOnTurnLimit` | true | show the continue question |
| `continueQuestionTimeoutMinutes` | 5 | 0 = no timeout |

## Limits (OrchestratorLimits)

| Limit | Default |
|---|---|
| `maxRecoveryDepth` | 2 |
| `maxRecoveriesPerRun` | 4 (layer-0 retries + layer-1 calls) |
| `maxSubTasks` | 5 |
| `recoverySummaryChars` | 500 |
| `maxActionsInRecoveryBrief` | 20 |
| `maxContinuations` | 2 per task |
| `maxContinueQuestionsPerRun` | 4 |

## Debug logs

- Recovery lines use category `recovery`, prefixed `[run <runId>]`, e.g. `layer 1: TURN_LIMIT on task ...`.
- Ollama request lines start with `num_ctx=<value or default>`.
- Settings and format: `docs/DEBUG_LOGGING.md`.

## Code

- `src/main/kotlin/com/adb/stewart/agents/FaultRecovery.kt`: classify, stuck check, continue question, recovery actions.
- `src/main/kotlin/com/adb/stewart/agents/SplitRecovery.kt`: `submit_recovery` parser, brief, assembly.
- `src/main/kotlin/com/adb/stewart/agents/Scratch.kt`: scratch dirs, prune, `ScratchApprovalGate`.
- `src/main/kotlin/com/adb/stewart/agents/Orchestrator.kt`: layer 0/1/2 hooks, `OrchestratorLimits`.
- `src/main/kotlin/com/adb/stewart/chat/ChatSession.kt`: continue question wiring, plain chat.
- `src/main/kotlin/com/adb/stewart/provider/ollama/OllamaProvider.kt`: `options.num_ctx`.

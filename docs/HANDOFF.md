# Handoff — post-M8 open items

**Status: items 1, 2, 3, 4 and 6 are done in M9 (`52edf9e`, `78eb17a`, `0a45997`, `d69c2e8`, `6d07631`). Only item 5 remains, plus the manual `runIde` Stop check from item 4. The text below is the original plan.**

State at handoff: `main` @ `b28af5d`, clean. M1–M8 were done.
591 tests pass (4 live tests skipped). `koverVerify` passes at 96% line and 81% branch.
`verifyPlugin` passes on IDEA 2025.1 and PyCharm 2025.3.
The items below expand `docs/PLAN.md` → Open Items. Work through them in the order given.

## Rules for every item (from `AGENTS.md`)
- Add tests for both the positive and the negative case in the same change.
- `./gradlew test koverVerify` must pass (≥90% line, ≥80% branch).
- Run `./gradlew verifyPlugin` before any commit that touches `plugin.xml`, the UI, or platform APIs.
- Commit each item on its own.
- Add a line to `docs/PROGRESS.md` → Post-M8 changes, with the commit hash.
- Remove the item from PLAN Open Items and from PROGRESS Open items.
- Do not push unless asked.

---

## 1. Worker dispatch context
**Today.** `Orchestrator.runTasksSerially` (`agents/Orchestrator.kt:449`) sends each worker this text, with empty history:
`Goal: …\nMilestone: …\nTask N: …`
That keeps the worker isolated, but two things are missing:
- The worker never sees results from earlier tasks it depends on.
- The worker gets no file or symbol pointers.

**Change.**
1. Add `internal fun workerBriefing(goal, milestone, task, prior: List<WorkerResult>, maxChars): String` in `agents/`. It is a pure function.
   - Output is caveman-terse, one fact per line:
     ```
     Goal: <goal>
     Milestone <id>: <title>
     Task <id>: <description>
     Files: a.kt, b.kt            (omit if none)
     Prior #<id> <status>: <summary>   (one line each)
     ```
   - Bound the whole text to `limits.maxHandoffChars`. Use the existing `bound()`, or truncate the oldest `Prior` lines first.
2. Extend `DispatchTask` with `files: List<String> = emptyList()` and `dependsOn: List<Int> = emptyList()`.
   - Add both as **optional** properties in the `submit_tasks` schema (`ProtocolTools.tasksTool`).
   - Parse them in `parseTasks`. Note that `ToolRegistry.validate` does not check nested items, so `parseTasks` must reject:
     - non-string entries in `files`;
     - non-int entries in `depends_on`;
     - `depends_on` ids that are not earlier tasks in the same round.
3. In `runTasksSerially`, pass only the results whose ids are in `task.dependsOn` (from the current round). Leave the worker's history empty.
4. Update the `Protocol.EXECUTOR` text to tell the Executor to fill in `files` and `depends_on`.

**Tests.**
- `OrchestratorParseTest`:
  - `files` and `depends_on` parse correctly, and absent fields default to empty;
  - non-string file, non-int dependency, a forward dependency and an unknown dependency are each rejected.
- New briefing unit test:
  - the format is correct;
  - empty `files` and empty `Prior` lines are omitted;
  - truncation keeps the Task line.
- `OrchestratorTest`, using a scripted fake provider:
  - the worker request contains the summary of the task it depends on;
  - it does **not** contain results from tasks it doesn't depend on, Planner/Executor transcript text, or earlier milestones.

**Done when** a worker request carries only its own briefing and the results it explicitly depends on.

## 2. Branch-coverage headroom
- This item is test-only. Do not change production code.
- Run `./gradlew koverHtmlReport`. In `build/reports/kover/html/`, sort by branch coverage.
- Add negative-path tests to the lowest classes. Likely candidates: `ChatSession` error branches, `ErrorHints`, `AijbConfigurable` validation, `ClaudeStreamParser` edge events.
- Target: ≥83% branch.
- Do this after item 1, so its new code is counted.

## 3. Mid-run Planner questions (Open Question 3: allowed, not built)
**Design.**
- Add a **non-terminal** tool `ask_user {question: string, options?: string[]}`.
  - Offer it to the Planner only: the initial plan and the re-plan. Not to the Executor or the Worker.
- The tool's `execute` calls a new interface `UserPrompter.ask(question, options): String`. Inject it into `Orchestrator` the same way `ApprovalGate` is injected. The answer goes back as the tool result.
- Add `maxQuestions` (default 3) to `OrchestratorLimits`. Once the limit is used up, `execute` throws, and the model sees that as a tool error.
- Add a listener event `onQuestion(question, options)`.
  - The UI shows the question inline in `ChatPanel`, with a text field or option buttons.
  - Use a `CompletableDeferred` that the tool awaits.
  - Do **not** use a modal dialog. Stop must stay reachable (see item 4).
- Cancellation: Stop cancels the deferred, and the existing `RunCancelledException` path applies. The pending call's result is `Not answered: cancelled`.
- The question and answer are stored in the transcript like any other tool call and result, so history persistence needs no change.
- Update `Protocol.PLANNER` and `Protocol.REPLAN`: ask only when the request is ambiguous in a way that changes the plan.

**Tests.**
- With a fake prompter, the answer reaches the model.
- The limit is enforced (a fourth question is rejected).
- The tool is not offered to the Executor or the Worker.
- Cancelling while waiting gives `RunCancelledException`, and the partial transcript is kept.
- A `ChatPanel` test covers the inline prompt, both the answer case and the Stop case.

## 4. Approval dialog vs Stop
**Today.** `ApprovalDialogs.showDialog` (`ui/ApprovalDialogs.kt:58`) calls `showAndGet()` on a project-modal `DialogWrapper`. Stop can't be clicked while the dialog is open, and cancelling the coroutine does not close it.

**Change.**
- Show the dialog non-modally, with `DialogWrapper(project, true, IdeModalityType.MODELESS)` and `show()`.
- Complete a `CompletableDeferred<ApprovalDecision>` from `doOKAction`/`doCancelAction`.
- Await it inside `suspendCancellableCoroutine`. On cancellation, close the dialog on the EDT with `CANCEL_EXIT_CODE`.
- Keep the 1-dialog-at-a-time invariant. Tools still run serially, so this holds.
- Make the `ChatSession` cancellation report treat a call cancelled while awaiting approval as `Not executed`, not as uncertain.

**Tests.**
- Put a seam in front of dialog creation (for example `(DialogWrapper) -> Unit` or a small `DialogHost` interface), so tests don't need a real EDT.
- Approve, Reject, and cancel-while-open each produce the right decision, and cancel-while-open closes the dialog.
- `ToolLoopCancelTest`: cancelling during approval gives `Not executed`.
- Manual check in `./gradlew runIde`: with the approval dialog open, Stop is clickable and the dialog closes.

## 5. Native AIF tools: live check (needs the user's credentials)
- The user has to run this, because the agent has no AIF credentials:
  `AIF_LIVE=1 AIF_BASE_URL=… AIF_API_KEY=… AIF_MODEL=<model> ./gradlew test --tests '*AifLiveTest*'`
  with the model's tool path set to `NATIVE`.
- If it passes, record the model ids and the date in `docs/COMPATIBILITY.md`.
  - Decide whether `AifProvider.supportsNativeTools` should default those ids to native. Today native is opt-in per model (see `settings/ToolPathResolver.kt`).
- If it fails, record the failure code. The shim stays the default and no code changes.

## 6. Optional cleanup: `ChatSession`
- This is a behaviour-preserving refactor. `ChatSessionTest` must pass unchanged.
- Extract `private fun commitIfActive(job: Job?, messages: List<ChatMessage>)`. It replaces the four `synchronized(lock) { if (activeJob === thisJob) { clear; addAll } }` blocks at `chat/ChatSession.kt:222–266` and `:339–345`.
- Fix the comment at `:342`. Role prompts are never in `result.messages`. The `SYSTEM` filter actually drops the orchestrator's "Re-planning: …" markers.
- Add one test: a stale job (a new request started) does not overwrite the transcript.

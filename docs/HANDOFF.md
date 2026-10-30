# Handoff — finish the build (post-M9)

**Status (2026-10-30): done.** Item 1 `96a5051`, slices 2a–2e `824d5de`…`5fe43d3` (M10 in `docs/PROGRESS.md`). Open: manual `runIde` check; `/resume`/`/memory` deferred. The plan below is kept for reference.

State at handoff: `main` @ `eb43ba2`, clean. M1–M9 are done (see `docs/PROGRESS.md`).
At `a48729f`: 675 tests passed (5 live tests skipped); `koverVerify` passed at 97.1% line and 84.6% branch.
`verifyPlugin` passes on IDEA 2025.1 and PyCharm 2025.3.
The post-M8 handoff (items 1–6) is done. Its text is in git history (`d44daa2`).

Remaining work, in this order:
1. Fix the flaky test. It is a real cancellation bug.
2. Slash commands, slices 2a–2e.

## Rules for every item (from `AGENTS.md`)
- Add tests for both the positive and the negative case in the same change.
- `./gradlew test koverVerify` must pass (≥90% line, ≥80% branch).
- Run `./gradlew verifyPlugin` before any commit that touches `plugin.xml`, the UI, or platform APIs.
- Commit each item or slice on its own.
- Add a line to `docs/PROGRESS.md` → Post-M8 changes, with the commit hash.
- When an item is done, remove it from PLAN Open Items and from PROGRESS Open items.
- Do not push unless asked.

---

## 1. Stop before the run starts: no callback (flaky `ChatSessionTest`)
**Symptom.** `ChatSessionTest` "a stale job does not overwrite the transcript but the active one does" fails about half the time. The failing line is `ChatSessionTest.kt:265`, where `pumpUntil(listener.cancelled)` times out. On 2026-10-30 it failed 3 of 4 runs.

**Cause (confirmed).**
- `ChatSession.send` (`chat/ChatSession.kt:182`) calls `cs.launch { … }` with the default `CoroutineStart`.
- The test calls `session.cancel()` immediately. If the job is cancelled before it is dispatched, its body never runs. That means no `catch`, so no `onCancelled`, and no `finally`, so `activeJob` stays set and `persist()` is skipped.
- When the test was changed to wait for the first delta, it passed 6/6 runs.

**Production impact.**
- If the user presses Stop right after Send, `ChatPanel.sendButton` stays on "Stop".
- The transcript keeps the USER message with no cancel marker.
- Clear recovers it.

**Fix.**
- Make the launched body always run its handlers. Two options:
  - `cs.launch(start = CoroutineStart.ATOMIC)`. The first suspension then throws `CancellationException`, and the existing catch/finally runs.
  - A completion handler that calls `onCancelled` and clears `activeJob` when the body never started.
- Do **not** use `UNDISPATCHED`. `launch` runs inside `synchronized(lock)` before `activeJob = newJob` (`:270`), so the body would see `activeJob !== thisJob`.
- Check the orchestrator path, `runOrchestrator` (`:280`), for the same gap.

**Tests.**
- New test: cancel immediately after `send`, with no sleep. Then:
  - `onCancelled` fires;
  - the transcript ends with `CANCEL_MARKER`;
  - a second `send` runs to completion.
  - Repeat the send/cancel ~20× in a loop to make the race likely.
- Existing stale-job test: wait for the first delta (`pumpUntilCond { listener.deltas.isNotEmpty() }`) before calling `commitIfActive`. That way it tests the commit and not the race.
- Run `./gradlew test --tests '*ChatSessionTest*' --rerun` at least 5×, and all runs must be green.

**Done when** Stop at any moment resets the UI, and `ChatSessionTest` passes on repeated runs.

---

## 2. Slash commands
Spec: `docs/PLAN.md` → Open Items 1 (the command table). Ship it in slices, one commit per slice.

### Design decisions (resolve these first)
- **Parse point.** `ChatPanel.onSendOrStop` (`ui/ChatPanel.kt:272`), after the empty-check and before the model check. `/help`, `/clear`, `/cost` and `/config` must work without a model selected.
- **What counts as a command.**
  - It is a command only if the **untrimmed** input starts with `/`. Today the text is trimmed at `:277`, so parse before trimming. Otherwise `" /help"` becomes a command.
  - `//x` is sent as plain text, with the leading `/` removed.
  - `/` mid-text is plain text.
- **During a run.**
  - Enter (`:110`) and the button both call `onSendOrStop`. While a run is active, that path means **Stop**, so typing `/cost` mid-run would cancel the run.
  - Fix: Enter parses first. `/help` and `/cost` run, other commands show "Not available while running", and plain text is ignored. Only the button stops the run.
- **Registry.**
  - `chat/SlashCommands.kt`: `SlashCommand(name, argHint, description, allowedWhileRunning, handler)`.
  - `parse(input): Parsed?` is a pure function that returns `name` and `args`.
  - Handlers get a small `CommandContext` interface that `ChatPanel` implements. Tests use a fake.
- **Unknown command** → a local error message: `Unknown command /x — type /help`. Nothing is sent. The input text is kept.
- **Output** of local commands is added as a `system` message in the panel. It is not added to the transcript and not sent to the model.

### 2a. Parser, registry, `/help`, unknown-command handling
- Tests:
  - parse: name, args, extra whitespace, uppercase name (reject or lowercase it; pick one);
  - `//`, mid-text `/`, a lone `/`, unknown command;
  - `/help` lists every registered command;
  - nothing reaches `session.send` for a command.

### 2b. `/clear`, `/cost`, `/config`, `/model`
- `/clear` → `onClear()` (`:142`) → `ChatSession.clearHistory` (`ChatSession.kt:156`).
- `/cost` → `session.sessionUsage` (`:110`) formatted with `UsageFormat`. With no usage it shows "No usage yet".
- `/config` → `ShowSettingsUtil.getInstance().showSettingsDialog(project, AijbConfigurable::class.java)` (id `com.aijb.assistant.settings`, `plugin.xml:8`).
- `/model`:
  - With no argument, show the current model and open the `modelCombo` (`:57`) popup.
  - With an argument, match `provider/model` exactly, or else match a bare model id when it is unique.
  - If the match is ambiguous or there is none, show an error that lists the candidates.
- Each command needs a positive and a negative test. Also test that they are blocked during a run (`/cost` is allowed).
- Run `verifyPlugin` (this slice touches the UI and platform APIs).

### 2c. `/compact [focus]`
- `ContextCompactor.compactIfNeeded` (`chat/ContextCompactor.kt:23`) is gated by a threshold and uses a fixed `SUMMARY_PROMPT`.
- Add a forced path: `compact(provider, model, messages, focus: String?)`. It skips the threshold check and appends the focus text to the summary prompt.
- Keep the existing early returns:
  - `cut <= 0` → "Nothing to compact";
  - already summarised → "Already compact".
- Run it through `ChatSession`. The commit uses `commitIfActive` and fires the existing `onCompacted` and `onCompactionFailed` events.
- Tests: forced compaction with and without focus, nothing to compact, provider error, and blocked during a run.

### 2d. `/init`, `/review`
Both are canned prompts sent with `session.send`. In multi-model mode they go through the Orchestrator like any other message.
- `/init`: asks the model to inspect the project and write `AGENTS.md` with `WriteFile`. The approval gate applies.
- `/review [focus]`:
  - Get the diff locally with the VCS API (`ChangeListManager` + `ChangesUtil`/patch builder) or with `git diff HEAD`. Run it read-only, without `RunTerminal`, so there is no approval prompt.
  - Bound the diff to `maxHandoffChars` and note the truncation.
  - Send the prompt with the diff inlined.
  - With no changes, show "No changes to review" and send nothing.
- Tests: the prompt contains the diff, truncation, no diff, and not a VCS repo.

### 2e. Autocomplete popup
- When the input starts with `/` and has no space yet, show a `JBPopup` list filtered by prefix. Tab or Enter inserts the name; Esc closes the popup.
- Keep the filter logic pure so it can be tested. Test the prefix filter, no matches, and the popup hidden once a space is typed.
- Run `verifyPlugin`.

**Done when** all 8 commands work in `./gradlew runIde`, and the PLAN open question (`/resume`, `/memory`) is either recorded as deferred or answered.

---

## After both items
- Update `docs/PROGRESS.md`: add an M10 row, or post-M9 lines, with hashes, test counts and coverage.
- Update `docs/PLAN.md` → Open Items to "none", or to whatever is left.
- `./gradlew buildPlugin verifyPlugin`, then `scripts/install-plugin.sh --no-build` for a manual smoke test.

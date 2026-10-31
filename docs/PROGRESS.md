# Progress

Milestone status against `docs/PLAN.md`. Update on every milestone commit.

| Milestone | Status | Notes |
|-----------|--------|-------|
| 1. Skeleton | Done (`e5004d8`) | Chat tool window, `OllamaProvider`, cancellation. Claude gate passed: CLI 2.1.309 (`docs/CLAUDE_FEASIBILITY.md`). |
| 2. AIF + shim + ToolLoop | Done (`4d059e1`) | `AifProvider`, `RequestTranslator`/`StreamTranslator`/`ToolCallParser`, `ToolLoop`/`ToolRegistry`. Parity: `docs/SHIM_PARITY.md`. |
| 3. Claude provider | Done (`e14acf1`) | CLI subprocess transport, `ClaudeStreamParser`, `ClaudeTranscript`, isolation policy + recorded-stream fixtures. |
| 4. Picker + settings | Done (`5ff2ba0`, `e6e0024`, `a7755d0`) | `RolesPanel`, `AijbConfigurable`/`AijbSettings`, PasswordSafe, auto-compact setting, `RolePrompts` injection in multi-model mode. |
| 5. Tools | Done (`de8b7f4`) | `ProjectTools` (ReadFile/FindFiles/Search/WriteFile/EditFile/RunTerminal), `ProjectPaths` root+symlink enforcement, `ApprovalDialogs`; 448 tests passed with 4 live tests skipped; coverage and IDEA/PyCharm verification passed. |
| 6. Three-level orchestrator | Done (`8bb6914`) | `Orchestrator` plan → dispatch → worker → re-plan protocol, terminal protocol tools in `ToolLoop`, per-level usage summing and listener events. 491 tests passed incl. 30 protocol-parser tests; `koverVerify` gates passed. |
| 7. Multi-model dispatch | Done (`6588202`) | `RoleRouting` binds each role to its `ModelRef` (unset → chat selection); `Orchestrator` takes per-level `LevelRoute`s; destination shown on each level header before dispatch; missing provider fails with no fallback; failures name `provider/model`; handoff text bounded (`maxHandoffChars`). 507 tests passed (4 live skipped); `koverVerify` and IDEA/PyCharm verification passed. |
| 8. Hardening | Done (`820bb94`) | End-to-end cancellation (`RunCancelledException` keeps the partial transcript, uncertain tool outcomes reported, background process trees killed), per-project history persistence (retention setting, Clear button, atomic writes), token/cost display (usage summed over turns, compaction and failed/cancelled runs; cost only when provider-reported), error codes with hints. 576 tests passed (4 live skipped); `koverVerify` (line 96%, branch 81%), `buildPlugin` and IDEA 2025.1 / PyCharm 2025.3 `verifyPlugin` passed. Fixed: edits no longer force a non-undoable `reloadFromDisk`, so an approved edit is undoable from the editor. |
| 9. Post-M8 open items | Done (`52edf9e`…`78eb17a`) | Worker briefing, Planner `ask_user`, modeless approval dialogs, branch-coverage headroom, `commitIfActive` refactor — see Post-M8 changes. 671 tests passed (4 live skipped); `koverVerify` (line 97%, branch 84.6%) and IDEA 2025.1 / PyCharm 2025.3 `verifyPlugin` passed. Native AIF live check passed on `glm-5-3-flash` (item 5); native is now the AIF default, shim deprecated (fallback). |
| 10. Slash commands | Done (`824d5de`…`5fe43d3`) | `/help`, `/clear`, `/cost`, `/config`, `/model`, `/compact`, `/init`, `/review` + autocomplete; cancel-before-start fix (`96a5051`). 755 tests passed (5 live skipped); `koverVerify` (line 96.8%, branch 85.2%) and IDEA 2025.1 / PyCharm 2025.3 `verifyPlugin` passed. Manual check of all 8 commands + autocomplete passed in PyCharm 2026-10-31. |

## Post-M8 changes

- Managed-policy check (Claude check 6) passed 2026-10-29 on CLI 2.1.312 (`6cac71c`) — `docs/CLAUDE_FEASIBILITY.md`.
- Routing refactor (`707013c`): single-model `ChatSession` path and `RoleRouting.resolve` share `RoleRouting.routeFor`; test-only single-model `Orchestrator` constructor removed (tests use `RoleRouting.uniform`). 579 tests passed (4 live skipped); `koverVerify` passed.
- Protocol-tool refactor (`22eefc8`): `ProtocolTool` validates plan/task/result arguments in `execute` (bad submissions retry within the level's turn budget instead of failing the run); `LoopResult.Completed.submitted` replaces the post-hoc message search. 591 tests passed (4 live skipped); `koverVerify` and IDEA/PyCharm `verifyPlugin` passed.
- Worker briefing (`52edf9e`): `workerBriefing` gives each worker its goal, milestone, task, `files` and only the results of `depends_on` tasks; `submit_tasks` gains optional `files`/`depends_on`, validated in `parseTasks`.
- Planner questions (`0a45997`): non-terminal `ask_user` tool (Planner only, `maxQuestions` = 3 across plan and re-plans), inline answer panel in `ChatPanel`; Stop gives `Not answered: cancelled`.
- Modeless approval dialogs (`d69c2e8`): Stop stays reachable; cancel closes the dialog and the call reports `Not executed`. Manual check passed in the installed plugin (2026-10-29): Stop clickable with the dialog open, dialog closed, run cancelled.
- `ChatSession.commitIfActive` (`6d07631`): replaces four commit blocks; `SYSTEM`-filter comment fixed.
- Branch-coverage tests (`78eb17a`): branch 81.6% → 84.6%, line 97.1%; test-only.
- AIF native by default; shim deprecated (`206065b`): `AifProvider` is native unless the model has a `SHIM` override; shim kept as the fallback for models with tool calls disabled.
- Native null fields (`a48729f`): `NativeCallCollector` treats JSON `null` `id`/`type`/`name`/`arguments` as absent (was the string "null"; `type: null` was rejected). 675 tests passed (5 live skipped); `koverVerify` passed.
- Stop before the run starts (`96a5051`): the send job launches with `CoroutineStart.ATOMIC` and checks cancellation first, so `onCancelled`, the cancel marker, `activeJob` reset and persist always run (was: Send button stuck on Stop; flaky `ChatSessionTest`). 677 tests passed (5 live skipped); `koverVerify` (line 97.1%, branch 85.1%) passed; `ChatSessionTest` green 5/5 reruns.
- Slash commands 2a (`824d5de`): `SlashCommands` parser/registry, `/help`, unknown-command error (input kept). A command only when the untrimmed input starts with `/`; `//` escapes; names lowercased. Enter parses first even mid-run (`/help`, `/cost` run; others "not available while running"; plain text ignored); only the button stops a run.
- Slash commands 2b (`9c9134a`): `/clear`, `/cost` ("No usage yet" when empty), `/config` (Settings page), `/model [provider/model | unique id]` (ambiguous/unknown list candidates; no arg shows current and opens the picker). verifyPlugin passed.
- Slash commands 2c (`eadeeeb`): `/compact [focus]` — `ContextCompactor.compact` skips the threshold and appends the focus; `ChatSession.compact` runs as the active run through the shared ATOMIC launcher `startRun`; "Nothing to compact" / "Already compact" via `onCompactionSkipped`; Stop leaves the transcript untouched (no cancel marker).
- Slash commands 2d (`a0a2b37`): `/init` (canned AGENTS.md prompt, WriteFile approval applies), `/review [focus]` (`GitDiff`: `git --no-pager diff --no-color --no-ext-diff HEAD` off the EDT, no `RunTerminal`). Deviation from the handoff: the diff is bounded to `REVIEW_MAX_DIFF_CHARS` = 20000, not `maxHandoffChars` (2000 ≈ 40 lines, too small to review), with a truncation note. No changes / no commits / not a repo are local messages.
- Slash commands 2e (`5fe43d3`): autocomplete popup (non-focusable, keys stay in the input): Tab inserts, Enter inserts a partial name and runs a full one, Up/Down move, Esc hides until the text changes. 755 tests passed (5 live skipped); `koverVerify` (line 96.8%, branch 85.2%) and IDEA/PyCharm `verifyPlugin` passed.

## Requested follow-ups (not started)

From `docs/todo.txt` (details and acceptance criteria in `docs/PLAN.md` → Open Items / Requested follow-ups):

- Qwen/AIF file-write investigation — resolved 2026-10-31: `AifEditLiveTest` runs a real `WriteFile`+`EditFile` cycle on `qwen3-8-27b` on SHIM and NATIVE; the reported incompatibility did not reproduce. Post-write read-back added to `EditTool`: the saved file is re-read and compared with the approved `FileChange.after`; mismatch or missing file fails with uncertain side effects (tests: success, mismatch, missing, stale preview, cancellation).
- Visual Studio: separate host feasibility (versions, packaging, UI, approval/undo model); the JetBrains verifier results do not cover it.
- Nemotron: resolved — the AIF model is `nemotron-3-embed-8b`, embeddings only; `/chat/completions` returns HTTP 404, so there is no chat/tool route.

## Open items

Tracked in `docs/PLAN.md` → Open Items:

- ~~Manual `runIde` check of the 8 slash commands and autocomplete~~ — verified 2026-10-31 in PyCharm.
- ~~AIF model discovery~~ — done 2026-10-31: `listModels()` queries `GET <base>/models`, unions API ids with configured extras; live `AifLiveTest.live aif lists models` passed.
- ~~Ollama native tools~~ — done 2026-10-31 (uncommitted): capability discovery via `/api/tags` and cancellation-safe `/api/show` probes; native requests, ordered stream events, unique call IDs, and named tool results. Unknown capability uses the shim; explicit unsupported native calls fail without replay. Localhost fixture tests cover approved read/edit/command flows, rejection, malformed responses, and cancellation. Final gate: 812 tests / 0 failures / 7 skipped; `koverVerify`, `verifyPlugin`, and `buildPlugin` passed. Live `north-mini-code-1.0:latest`: list/stream, native round trip, and shim/native write-edit checks passed; the final native round trip was rerun after review.
- Deferred: `/resume`, `/memory` (history is per-project, so `/resume` is likely redundant).

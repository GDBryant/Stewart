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

## Open items

Tracked in `docs/PLAN.md` → Open Items; plan in `docs/HANDOFF.md`:

- Possible bug: `NativeCallCollector.feed` turns JSON `null` name/arguments into the string "null" and rejects `"type":null`.

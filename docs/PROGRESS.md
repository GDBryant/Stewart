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

## Post-M8 changes

- Managed-policy check (Claude check 6) passed 2026-10-29 on CLI 2.1.312 (`6cac71c`) — `docs/CLAUDE_FEASIBILITY.md`.
- Routing refactor (`707013c`): single-model `ChatSession` path and `RoleRouting.resolve` share `RoleRouting.routeFor`; test-only single-model `Orchestrator` constructor removed (tests use `RoleRouting.uniform`). 579 tests passed (4 live skipped); `koverVerify` passed.
- Protocol-tool refactor (`22eefc8`): `ProtocolTool` validates plan/task/result arguments in `execute` (bad submissions retry within the level's turn budget instead of failing the run); `LoopResult.Completed.submitted` replaces the post-hoc message search. 591 tests passed (4 live skipped); `koverVerify` and IDEA/PyCharm `verifyPlugin` passed.

## Open items

No M9 is planned. Tracked in `docs/PLAN.md` → Open Items; plan in `docs/HANDOFF.md`:

- Worker dispatch context (task-relevant, caveman-terse briefing).
- Branch coverage 81% vs 80% gate: little headroom.
- Mid-run Planner questions (Open Question 3): not built.
- Approval dialogs are project-modal: Reject is the cancel path (Stop unreachable); no close-on-cancel.
- Native AIF support remains per-model opt-in until confirmed against the live account.
- Optional: `ChatSession` transcript-commit helper; fix misleading `SYSTEM`-filter comment.

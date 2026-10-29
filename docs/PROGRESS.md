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
| 7. Multi-model dispatch | Done (uncommitted) | `RoleRouting` binds each role to its `ModelRef` (unset → chat selection); `Orchestrator` takes per-level `LevelRoute`s; destination shown on each level header before dispatch; missing provider fails with no fallback; failures name `provider/model`; handoff text bounded (`maxHandoffChars`). 507 tests passed (4 live skipped); `koverVerify` and IDEA/PyCharm verification passed. |
| 8. Hardening | Partial groundwork | Auto-compaction and cancellation pieces in place; end-to-end cancellation + token/cost display + history persistence outstanding. |

## Outstanding checks / debts

- Worker dispatch context: only send task-relevant context to sub-workers, compacted to caveman-style terseness (see M7 notes in `docs/PLAN.md`).

- Managed-policy inspection (Claude check 6) still pending manual verification — `docs/COMPATIBILITY.md`.
- Native AIF support remains per-model opt-in until confirmed against the live account.
- Open questions in PLAN.md all resolved or parked.

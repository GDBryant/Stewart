# Progress

Milestone status against `docs/PLAN.md`. Update on every milestone commit.

| Milestone | Status | Notes |
|-----------|--------|-------|
| 1. Skeleton | Done (`e5004d8`) | Chat tool window, `OllamaProvider`, cancellation. Claude gate passed: CLI 2.1.309 (`docs/CLAUDE_FEASIBILITY.md`). |
| 2. AIF + shim + ToolLoop | Done (`4d059e1`) | `AifProvider`, `RequestTranslator`/`StreamTranslator`/`ToolCallParser`, `ToolLoop`/`ToolRegistry`. Parity: `docs/SHIM_PARITY.md`. |
| 3. Claude provider | Done (`e14acf1`) | CLI subprocess transport, `ClaudeStreamParser`, `ClaudeTranscript`, isolation policy + recorded-stream fixtures. |
| 4. Picker + settings | Done (`5ff2ba0`, `e6e0024`, `a7755d0`) | `RolesPanel`, `AijbConfigurable`/`AijbSettings`, PasswordSafe, auto-compact setting, `RolePrompts` injection in multi-model mode. |
| 5. Tools | Built (uncommitted) | `ProjectTools` (ReadFile/FindFiles/Search/WriteFile/EditFile/RunTerminal), `ProjectPaths` root+symlink enforcement, `ApprovalDialogs`; 448 tests passed with 4 live tests skipped; coverage and IDEA/PyCharm verification passed. |
| 6. Three-level orchestrator | Not started | Only `AgentRole` + `RolePrompts` exist. No plan/task/result protocol, dispatcher, or re-plan logic yet. |
| 7. Multi-model dispatch | Not started | Per-role `ModelRef` settings exist (`RolesPanel`); no per-level routing/execution. |
| 8. Hardening | Partial groundwork | Auto-compaction and cancellation pieces in place; end-to-end cancellation + token/cost display + history persistence outstanding. |

## Outstanding checks / debts

- Managed-policy inspection (Claude check 6) still pending manual verification — `docs/COMPATIBILITY.md`.
- M5 working tree changes uncommitted; native AIF support remains per-model opt-in until confirmed against the live account.
- Open questions in PLAN.md all resolved or parked.

# Progress

v2 rebuild on branch `v2`, per `docs/future/ARCHITECTURE.md`. One commit per milestone.

| Milestone | Scope | Status |
|---|---|---|
| — | v1 removed; plan committed | Done |
| 1 | Monorepo, protocol, core skeleton, VS Code host, webview chat, OpenAI-compatible + Ollama streaming, cancel | Done |
| 2 | JetBrains host: sidecar, JCEF, HostPort | Pending |
| 3 | Config files, channel instances, agents, billing, settings UI | Done |
| 4 | Tool loop, tools, execution contract, permissions, shim | Done |
| 5 | Claude CLI channel | Pending |
| 6 | Roles + skills: defaults, tickboxes, resets, enforcement | Pending |
| 7 | Orchestrator, plan validator, parallel tasks, fault recovery, ledger, cost limit | Pending |
| 8 | Images, memory, editor actions, diagnostics, history, v1 import | Pending |
| 9 | Packaging: VSIX + per-OS JetBrains zips, signing, releases | Pending |

## Notes
- Conformance fixtures carried from v1 history (`src/test/resources/claude/*`); shim/tool-call formats to be ported from v1 Kotlin tests.
- M4 (`3bdd46c`..`HEAD`): ported v1 `ToolCallParser` → `packages/core/src/tools/shimParser.ts` (`<tool_call>`, `<call>`, `<function=NAME>`, GLM `<arg_key>`, JSON repair, exec-alias → `RunTerminal`, native-call repair, TC-* failure codes). `toolLoop.ts` ports `ToolLoop.kt`: turn limits, duplicate-id detection, approval gate, 60s tool timeout, uncertain outcomes on cancel/timeout, transcript repair (`closeOpenToolCalls`), output truncation. Built-ins `ReadFile`/`FindFiles`/`Search`/`WriteFile`/`EditFile`/`RunTerminal` via `HostPort` (+`files.list`/`stat`); stale-preview and changed-since-approval rejection preserved. Grants: once/chat/always scopes, program-level command grants via POSIX shell splitter (`tools/approvals.ts`). `chat.approve`/`chat.answer` wired to `RunManager`. Tests: core 56 passing (shimParser 15, builtins 12, toolLoop 9).

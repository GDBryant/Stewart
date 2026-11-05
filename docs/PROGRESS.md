# Progress

v2 rebuild on branch `v2`, per `docs/future/ARCHITECTURE.md`. One commit per milestone.

| Milestone | Scope | Status |
|---|---|---|
| — | v1 removed; plan committed | Done |
| 1 | Monorepo, protocol, core skeleton, VS Code host, webview chat, OpenAI-compatible + Ollama streaming, cancel | Done |
| 2 | JetBrains host: sidecar, JCEF, HostPort | Pending |
| 3 | Config files, channel instances, agents, billing, settings UI | Pending |
| 4 | Tool loop, tools, execution contract, permissions, shim | Pending |
| 5 | Claude CLI channel | Pending |
| 6 | Roles + skills: defaults, tickboxes, resets, enforcement | Pending |
| 7 | Orchestrator, plan validator, parallel tasks, fault recovery, ledger, cost limit | Pending |
| 8 | Images, memory, editor actions, diagnostics, history, v1 import | Pending |
| 9 | Packaging: VSIX + per-OS JetBrains zips, signing, releases | Pending |

## Notes
- Conformance fixtures carried from v1 history (`src/test/resources/claude/*`); shim/tool-call formats to be ported from v1 Kotlin tests.

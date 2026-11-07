# Visual Studio support — feasibility (resolved)

Status: feasibility only, decision recorded 2026-10-31. **Target chosen: Visual Studio Code** (extension, TypeScript, cross-platform). Visual Studio 2022 (VSIX/.NET, Windows-only) is out of scope. Nothing in this repository changes; `docs/PLAN.md` Scope keeps non-JetBrains IDEs out until a separate project exists.

Recommendation: **go**, as a separate repository (`stewart-vscode`) written in TypeScript, reusing this repo's provider fixtures as a conformance corpus. Not a port of this codebase.

## 1. Target

| | Visual Studio 2022 | Visual Studio Code |
|---|---|---|
| Host model | VSIX, .NET, COM/DTE, Windows only | Extension host (Node/TypeScript), all desktop platforms |
| Chat UI | own tool window (WPF) | webview panel |
| Share with this repo | provider protocols only | provider protocols only |

The two share nothing beyond the HTTP/CLI protocols, so the choice is a product decision, not a technical one. VS Code was chosen: same platforms as the JetBrains plugin, a single language for core and UI, and a test harness that runs headless on Linux.

## 2. What is portable

Portable as specification and fixtures, not as code:

| Layer | Source here | Portable content |
|---|---|---|
| Ollama transport | `provider/ollama/OllamaProvider.kt`, `OllamaNdjsonTest` | `/api/chat` NDJSON shape, `/api/tags` + `/api/show` capability probe, `tool_calls[].function.arguments` as an object, missing ids, `native_tools_unsupported` on HTTP 400 |
| AIF transport | `provider/aif/AifProvider.kt` | SSE framing, `GET /models` union with configured ids, redacted errors, bearer auth |
| Claude transport | `provider/claude/ClaudeProvider.kt`, `ClaudeStreamParser.kt` | CLI flags, `--output-format stream-json` events, transcript rules, login probe (`claude auth status`) |
| Shim | `shim/ToolCallParser.kt`, `StreamTranslator.kt` | the tool-call formats and their near-miss negatives (`docs/SHIM_PARITY.md`) |
| Orchestration | `agents/Orchestrator.kt`, `AskUser.kt`, `WorkerBriefing.kt` | `submit_plan` / `submit_tasks` / `submit_result` / `ask_user` JSON schemas, level routing, turn budgets |
| Execution contract | `docs/PLAN.md` → Execution contract | validate → preview → approval → execute; freeze the path per turn; no replay; unknown capability uses the shim |
| Post-write check | `tools/ProjectTools.kt` `EditTool.applyChange` | re-read the saved file and compare with the approved content; mismatch is a failure, never silent success |

Not portable: everything under `tools/` (VFS, `Document`, `WriteCommandAction`, `ProjectPaths`), `ui/` (Swing), `settings/` (PasswordSafe, `Configurable`), `chat/` history persistence, `http/IdeHttpClients.kt` (IDE proxy/cert stores). Size for reference: ~6.5k main lines, ~12.9k test lines.

## 3. Host equivalents (VS Code)

| Need here | VS Code API | Notes |
|---|---|---|
| Secret store | `context.secrets` (`SecretStorage`) | per-user, OS keychain; never in `settings.json` |
| Undoable edit | `WorkspaceEdit` + `workspace.applyEdit` | one edit is one undo step; batch a file's change into a single `WorkspaceEdit` |
| Stale-preview check | `TextDocument.version` | compare before applying; changed version requires a new preview |
| Diff preview + approval | `vscode.diff` on a virtual document, or the webview | approval is our UI either way; no host dialog |
| Command run | `child_process.spawn` + `AbortController`, or `Terminal` | spawn gives captured stdout/stderr and cancellation; `Terminal` is display only |
| File search | `workspace.findFiles` + document scan, or bundled `rg` | no PSI/index; same substring-search limitation already accepted here |
| History | `context.workspaceState` / `storageUri` | per-workspace, mirrors `ChatHistoryStore` |
| Proxy/certs | `http.proxy` setting + `NO_PROXY`, `https-proxy-agent` | VS Code exposes no proxy API to extensions; Node `fetch` ignores proxy settings, so this must be read explicitly (the same class of bug fixed in `189fdb4`) |
| UI | `WebviewPanel` | chat, model picker, approval cards; markdown rendering in the webview |

## 4. Options and effort

| Option | Shape | Pros | Cons | Size |
|---|---|---|---|---|
| a. Separate repo, TypeScript | providers + shim + orchestration + tools reimplemented in TS; webview UI | no runtime dependency; normal VSIX distribution; native host APIs for edit/undo/secrets; headless tests on Linux | duplicate parsers and orchestration; parity drift risk; coverage gates re-established from zero | core ~4–5k TS lines, UI ~1–2k |
| b. Shared Kotlin core as a sidecar | Kotlin core as a local process over stdio JSON-RPC; thin TS extension | one source for parsers/orchestration; fixtures and tests stay in Kotlin | JVM or per-platform GraalVM binary inside the VSIX (~50 MB+ or three builds); process lifecycle, orphan handling, protocol versioning; approval and preview must cross the process boundary; harder debugging | core unchanged, +protocol and packaging |
| c. Decline | none | no cost | no VS Code support | — |

Chosen: **a**. The risky logic is the parsers and the execution contract, and both are already pinned by recorded fixtures and verbatim tests; those fixtures transfer as a conformance corpus, so a TS rewrite can be checked against the same inputs. Option b only becomes right if the Kotlin core must remain the single source of truth; its distribution and lifecycle cost is disproportionate for a single-user tool.

## 5. Phased plan for the separate repo

- **P1 — chat only.** Webview chat, Ollama (`/api/chat` streaming) and AIF (SSE) text paths, model picker, secret storage, cancellation, per-workspace history, token estimate. No tools. Gate: streaming, cancel and proxy behaviour match the fixtures.
- **P2 — tools.** `ReadFile`, `FindFiles`, `Search`, `WriteFile`, `EditFile`, `RunTerminal`; validate → diff preview → approval → apply; version recheck; post-write read-back; root/symlink boundary. Gate: positive and negative tests per tool, and a native-path matrix over Ollama and AIF.
- **P3 — Claude CLI + orchestration.** `claude` subprocess with `stream-json`, login probe, three-level orchestrator, `ask_user` panel, per-role model routing. Gate: recorded-stream fixtures, protocol parser tests, cancellation.
- **P4 — packaging.** `vsce package`, publisher + signing, `.vsix` smoke test on Windows/macOS/Linux, README and settings schema.

Test story: `vitest` for unit tests with `c8` coverage (set gates at ≥90% line, ≥80% branch to match here), `@vscode/test-electron` for the webview/activation smoke test. The Kotlin suite stays the reference for behaviour, not a runtime dependency.

## 6. Risks

- Parity drift between two implementations: mitigate by copying the recorded fixtures and the verbatim tool-call samples into the new repo and running them there.
- Webview UI cost: chat markdown, approval cards and the picker are all custom; this is the largest single chunk of new work.
- Proxy and certificate handling differs per platform and is not exposed by the API; must be verified manually against a real corporate proxy.
- No PSI: symbol-aware features available here through the platform are not available in VS Code; `Search` stays a text walk in both.
- Marketplace policy: the Claude CLI path requires an installed binary; the extension must degrade with an actionable message, as `ErrorHints` does here.

## 7. Done when

This document exists and the user has chosen the host and the option (done: VS Code, option a). No code in this repository changes. `docs/PLAN.md` Scope still lists non-JetBrains IDEs as out; widening it is a separate decision that starts the new repo, with its own plan, tests and gates.

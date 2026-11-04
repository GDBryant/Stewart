# JetBrains AI Plugin — High-Level Plan

## Goal
JetBrains plugin (Kotlin, Gradle IntelliJ Platform Plugin) with a chat tool window that can drive local Ollama models, Claude (enterprise account, Microsoft SSO via browser), and AI Factory models (OpenAI-compatible proxy with native tools and an explicit shim fallback), with per-message model selection and a multi-model mode that splits planning and execution across three agent levels.

## Scope
- In: chat tool window, model picker, Ollama + Claude + AI Factory providers, native tool calls (the tool-call shim is a deprecated per-model fallback), 3-level agent loop, file edits, terminal commands, settings UI.
- Out (for now): Jira integration, remote/shared sessions, non-JetBrains IDEs, MCP tools.

## Reference: Cline plugin
The installed Cline plugin (`bot.cline` 2.0.7, `~/.local/share/JetBrains/PyCharm2025.3/cline`) is worth studying for UX, not architecture:

- Cline ships a thin Kotlin host + a bundled Node runtime running the TypeScript core, talking over gRPC (`bot.cline.host.proto`, "hostbridge" classes). The chat UI is a webview in JCEF. We take a simpler path: all logic in Kotlin, Swing UI (or JCEF later if markdown/webview needs grow).
- Patterns to borrow: right-side tool window; Approve/Reject gate per tool call; separate Plan/Act model IDs (our per-role ModelRefs generalise this); editor popup action "Add to chat" and intention actions (explain/fix); `org.jetbrains.plugins.terminal` as an optional dependency for optional terminal display.
- Gap it leaves for us: Cline assumes the provider honours native `tool_calls`. Against the AIF proxy it prints `<tool_call>` markup as text (see `/srv/compose/aif_shim/docs/`). The AIF proxy now honours native `tool_calls`, so the shim (which closed that gap in-process) is deprecated and kept only as a fallback.

## Architecture

```
ToolWindow (chat UI, model picker, mode toggle, approval gates)
        |
 Orchestrator — Planner / Executor / Worker (each bound to a ModelRef)
        |
 ToolLoop — owns conversation, bounded model/tool cycles and cancellation
   ├── ModelProvider — canonical messages/events and provider/model capabilities
   │     ├── OllamaProvider (/api/chat, /api/tags)
   │     ├── AifProvider (OpenAI-compatible HTTP + API key)
   │     └── ClaudeProvider (CLI subprocess; see Auth)
   │           Native or ToolCallShim translation at each provider boundary
   └── ToolRegistry → validate → approval → execute → correlated result
         ReadFile, Search, WriteFile/ApplyPatch, RunTerminal
```

Threading: Kotlin coroutines; network/subprocess work off the EDT; UI updates on the EDT; every call carries a cancellable `Job` from M1.

### Execution contract
- Providers normalise text deltas, complete tool calls, completion status, usage and errors; `ToolLoop` owns tool execution on both native and shim paths. Freeze the selected ModelRef and native/shim path for each turn. Unknown tool capability uses the shim; never switch paths or replay actions midway through a turn.
- Validate registered tool names and schemas after repair. Execute only after successful response completion; incomplete streams, truncation, filtering and cancellation never release buffered calls. Preserve call IDs and return success, rejection or failure against the originating call; do not ingest both partial and final CLI text twice.
- Approval binds to the exact normalised arguments, command/cwd or diff. Revalidate paths and file versions before applying edits; changed content requires a fresh preview. File tools stay within approved project roots, resolving symlinks; commands always require explicit approval and are not a filesystem sandbox.
- Bound model turns, retries, tool duration/output and context size. Stop with an actionable result on exhaustion. Never automatically replay an edit or command after execution starts or its outcome becomes uncertain. Start with serial tool execution and one active worker per project.

### Tool-calling path per provider
| Provider | Path |
|---|---|
| Ollama | Native `tools` for models that support it; shim for models that don't |
| AIF | Native tools by default; shim (deprecated) only for a model whose tool calls are disabled, selected with an explicit per-model `SHIM` override |
| Claude CLI | Built-in tools disabled with `--tools ""`; isolated CLI configuration; our tools via shim text (M1 feasibility gate, M3 integration) |

Native/shim routing is a per-provider/per-model capability setting, with an explicit override; it is not AIF-specific. Native AIF tool calls are data, not permission for the provider to execute anything: the plugin intercepts complete calls, validates names and arguments, previews changes, asks for approval where required and executes only through `ToolLoop`. Malformed or incomplete native calls fail closed. If native calling fails, report the failure without executing buffered calls; the user can select the shim for a subsequent turn after confirming no side effects occurred. Never silently replay or switch paths in the same turn.

### Three agent levels
| Level | Name | Responsibility | Default model |
|---|---|---|---|
| 1 | Plan-the-plan | Clarify intent, ask questions, produce a goal + ordered milestones | Strong (Claude or AIF flagship) |
| 2 | Execute-the-plan | Turn one milestone into concrete tasks, dispatch to workers, verify, re-plan on failure | Strong or mid |
| 3 | Worker-bee | Perform one task: edit a file, run a command, report result | Fast/local (Ollama) or AIF small model |

Multi-model mode = the three-level orchestrator runs, each level on its own ModelRef from settings; an unset level uses the chat-window selection. Single-model mode = no orchestrator: one `ToolLoop` on the chat-window selection. Both paths build their provider route through `RoleRouting.routeFor`.

In multi-model mode every request carries a role system prompt (`RolePrompts`, per request, never stored or compacted) describing the three roles and telling the model to hand work down to a lower role where it can.

### Tool-call shim (ported from aif_shim)
**Deprecated.** The AIF proxy now supports native tool calls, which are the default. The shim is kept only as a fallback for a model whose tool calls are disabled (select it with a per-model `SHIM` override); Claude CLI still uses it because the CLI has no native tool path. No new shim features. The shim is a Kotlin port of `/srv/compose/aif_shim` (`parser.py`, `translate.py`), sitting between providers and the `ToolLoop` as an explicit per-model alternative — no external Python process.

- **Request side** (`prepare_request`): inject tool schemas into the system prompt inside `<tools>` with `<tool_call>` instructions (GLM-family models get `<call>` — their own `<tool_call>` token is swallowed upstream); rewrite assistant `tool_calls` history and `tool`-role messages into the same text format; merge adjacent same-role messages.
- **Response side** (`parse_tool_calls`): extract `<tool_call>` / `<call>` / `<function=NAME>` / GLM `arg_key/arg_value` blocks into OpenAI `tool_calls`; strip `<think>` into `reasoning_content`; best-effort JSON repair (unescaped quotes, bare values, missing closers); schema-driven argument coercion; alias normalisation mapped to our tool names (invented `bash`/`execute_command`/`run_commands` → `RunTerminal`, etc.); text emitted alongside calls is kept and shown (aif_shim's drop/relegate mode is a Cline workaround and is not ported).
- **Streaming**: buffer chunks that could start a call tag so raw markup never flashes in the UI; emit text only once it's safe; repair streamed native `tool_calls` deltas as a whole.
- **Policy**: nudge-retry once when a tool-offered turn ends with no call and only an announcement ("Let me check ..."); surface an `empty_turn` error instead of a silent stop; withhold calls on `finish_reason` `length`/`content_filter`; never repair an unterminated JSON string into a runnable call (fail closed). Parsing is not authorisation: calls must pass the execution contract, and quoted examples or tool-result content must not become executable calls.
- **Parity**: port `tests/` fixtures from aif_shim verbatim — each parser case keeps the exact text seen in the wild. New formats observed get added to the Kotlin parser with a verbatim test, same rule as aif_shim's `docs/skills/tool-call-format`. Record the Python source revision or content hashes and intentional Kotlin differences alongside the fixtures.
- **Override**: per-provider/per-model native/shim selection; AIF defaults to native, and `SHIM` is the explicit fallback. A failure on the native path is surfaced, not silently retried through the shim; a later turn can use an explicit shim override. Keep text-only chat available when tools are disabled.

### Model selection
- Picker in chat header lists Ollama models (live from `/api/tags`) + configured Claude and AIF models.
- Selection applies to single-model mode; in multi-model mode the picker sets the Planner, and per-role overrides live in a popover/settings.
- AIF models are configured by ID (as listed in the AI Factory Portal); the shim's per-model call-tag table is applied automatically.

### Claude auth (enterprise, Microsoft SSO)
Transport: **Claude Code CLI subprocess**, passed the M1 feasibility gate on CLI 2.1.309. Invocation: `claude -p --output-format stream-json --verbose --include-partial-messages --tools "" --safe-mode --strict-mcp-config --no-session-persistence --disable-slash-commands --model <model> --system-prompt-file <file>`, launched with an argument list that preserves the empty `--tools` argument, with the transcript on stdin.
- Each call runs in a fresh empty temp directory (no project CLAUDE.md/.claude); the system prompt lives in a temp file outside it; both are deleted after the call. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from the child environment so SSO auth cannot silently fall back to an API key.
- Transcript: a single USER message is sent verbatim; multi-turn history is wrapped in `<user>`/`<assistant>` blocks (tool results already rewritten to user text by the shim). A `Completed` is emitted only after the process exits 0 with a successful `result` event; nonzero exits and missing results become `Failed` with codes (`auth`, `cli_exit`, `incomplete_stream`, `cli_not_found`, `isolation_violation`, `model_unavailable`, `rate_limited`, `cli_error`).
- Isolation policy: refused `tool_use` blocks and the server-side `advisor` tool are allowed; any executed (non-error) `tool_result`, any other server tool, or non-empty init `tools`/`mcp_servers` → `isolation_violation` and the process is killed.
- Local CLI 2.1.309 help confirms the tool-disable and isolation flags; the documented streaming flags provide token deltas. This is interface evidence only: enterprise SSO, organisation policy and runtime isolation still need validation. Do not use `--bare` for this path: its documented auth mode excludes OAuth/keychain login.
- The CLI owns login and refresh. Verify the enterprise account actually supports Claude Code; Microsoft SSO alone does not establish CLI access or usage permission. Hooks, plugins, MCP and managed configuration must not introduce execution outside the plugin gates. If isolation cannot be demonstrated, disable this transport and revisit the design.
- Use a plugin-owned transcript sent to a fresh subprocess for each model turn; encode tool history through the shim. Do not use implicit CLI session resume. Use configured model IDs/aliases unless a supported discovery interface is verified.
- Defer the optional Anthropic API-key provider until CLI feasibility is settled; it is a separate authenticated transport, not an SSO fallback that can silently be selected.

### Persistence
- Settings: `PersistentStateComponent` (provider URLs, per-role models, CLI path, shim toggles).
- Secrets: AIF API key in `PasswordSafe`, not in project files.
- Chat history: per-project JSON in the plugin state dir (not `.idea/`, which is often committed). Old AIJB settings, permissions, API key and history are migrated on first load (`docs/RENAME_PLAN.md`). Keep diagnostic logs free of credentials; provide history deletion and a retention setting.
- Network: HTTP providers use the IDE proxy and certificate settings for corporate networks; configure and validate the subprocess network environment separately, since the CLI does not inherit IDE HTTP settings automatically.

## Milestones
Each milestone ships its own tests and passes `buildPlugin`, `check` (tests + `koverVerify`: ≥90% line, ≥80% branch) and `verifyPlugin` before the next starts. UI components get headless tests. Automated provider tests use recorded fixtures/fakes; live-provider smoke checks are separate and require locally configured access.

### 1. Skeleton
- Gradle IntelliJ Platform Plugin 2.x project, pinned Gradle/Kotlin versions and Java 21 toolchain; provisional since-build 251. Confirm the supported PyCharm/IDEA matrix and verify each declared product rather than inferring compatibility from Cline.
- Tool window on the right, message list + input box.
- Coroutine scope per project service; EDT/background split; cancellable `Job` per request.
- `ModelProvider` interface + `OllamaProvider` (streaming `/api/chat`, `/api/tags`).
- Streaming render into the chat view; send/cancel.
- CI: build, test, Plugin Verifier.
- Claude feasibility spike: verify enterprise CLI login, streaming flags, empty tool set and suppression of hooks/plugins/MCP under effective managed policy, using a disposable workspace. Record the supported CLI version; a failed gate blocks M3, not Ollama/AIF work.
- Done when: chat with a local Ollama model streams and cancels cleanly; CI green.

### 2. AIF provider, tool-call shim, tool loop core
- `ToolRegistry` (tool name + JSON schema) and single-agent `ToolLoop` (call → approval → execute → result back), tested with a fake tool. Cover approval denial, cancellation, schema rejection, duplicate events and uncertain execution outcomes with fake tools.
- `AifProvider`: OpenAI-compatible streaming SSE client; configure the actual upstream base URL ending in /api/proxy/v1 and append /chat/completions exactly once. Test URL joining. Store the API key in PasswordSafe from this milestone; M4 adds the full settings UI.
- Port `prepare_request` (tool injection, history rewrite, message merge, per-model call tag).
- Port `parse_tool_calls` + JSON repair + coercion + alias normalisation to our tool names, with the aif_shim test corpus ported verbatim.
- Streaming tag-buffering and `tool_calls` delta repair (`StreamTranslator`, `NativeCallCollector` equivalents).
- Confirm AIF native support per model with complete streamed tool-call fixtures; test native requests, call/result correlation, invalid or interrupted calls, approval rejection and explicit shim selection after a native failure. Neither path may bypass `ToolLoop` or execute a buffered call before successful completion.
- Retry nudge, `empty_turn` error, finish-reason policy, `tool_choice`/`parallel_tool_calls` validation.
- Test chunk boundaries, interrupted/truncated streams, native versus shim routing, quoted call examples and loop limits; no tool runs before successful completion.
- Done when: ported aif_shim fixtures pass; an AIF model drives the fake tool through the loop end to end.

### 3. Claude provider
- Proceed only after the M1 CLI feasibility gate passes. Implement the verified invocation, explicit model selection, login-state reporting and subprocess network configuration.
- Disable built-in tools and configuration-driven execution; route shim calls into ToolLoop with plugin-owned conversation history.
- Test recorded CLI streams for partial/final deduplication, tool-result continuity, auth expiry, nonzero exits and cancellation; verify isolation in a disposable workspace against the supported CLI version.
- Done when: an authenticated Claude conversation completes multiple plugin tool turns, and isolation tests demonstrate no file/command execution outside the plugin approval gates.

### 4. Model picker + settings UI
- Chat-header picker; per-role overrides popover; settings page (provider URLs, keys → `PasswordSafe`, CLI path, per-provider/per-model shim toggle).
- Done when: settings persist across restarts; secrets are stored only through PasswordSafe and never serialised into plugin XML/JSON or logs.

### 5. Tools
- Read/search tools registered in `ToolRegistry`. `Search` walks the VFS inside project content with size and binary caps. It is deliberately not index-backed: the IDE word index holds whole words only, so a substring query (`ell` in `yellow`) cannot be answered from it, and `PsiSearchHelper.processElementsWithWord` hung under the tool execution model in the test harness. Search cost is therefore linear in project size; keep `path` and `max_results` narrow on large repositories.
- Write/patch with diff preview + Approve/Reject. Recheck document versions and apply through undoable WriteCommandAction; handle unsaved editor buffers.
- Command run via `GeneralCommandLine`/`OSProcessHandler` with captured output and approval gate; output displayed in the plugin, optionally mirrored to the IDE terminal (optional dependency).
- Enforce project-root/symlink boundaries for file tools; test rejection, stale previews, cancellation, process cleanup and output limits. Resolve index-dependent search correctly during IDE indexing.
- Done when: AIF native, AIF shim and Claude CLI paths each read, edit with approval and run a command with approval; native errors remain intercepted and do not trigger unapproved execution or an implicit shim retry. Covered by `ToolsProviderMatrixTest` (all three paths, plus rejection cases).

### 6. Three-level orchestrator
- Structured JSON messages (plan/task/result) between levels; single-model mode; role badges in chat.
- Validate plan/task/result schemas inside the terminal protocol tools (a rejection returns to the model as a normal tool error and is retried within the level's turn budget), correlate task IDs and propagate cancellation; bound re-planning and dispatch workers serially to avoid conflicting edits. Test malformed worker output and failed tasks.
- Done when: a multi-step task runs Planner → Executor → Worker with one model and re-plans on a failed task.
- Fault recovery (layers 0–2, continue question, scratch dir): see `docs/FAULT_RECOVERY.md`.

### 7. Multi-model mode
- Per-role `ModelRef` binding; per-level streaming and error surfacing.
- Pass explicit bounded context and results between roles; show destination provider before dispatch and never silently fall back from a local model to a remote provider. Test routing and provider failure with fakes.
- Worker dispatch context (**built in M9**, `agents/WorkerBriefing.kt`; `submit_tasks` carries optional `files`/`depends_on`): when starting any sub-worker task, (1) send only the context relevant to completing that one task — goal, its own task description, paths/names it must touch, prior task results it depends on — not the full chat/orchestrator history; (2) compact that context to caveman-style terseness: short telegraphic lines, no prose/etiquette filler, e.g. `Task: fix parsePlan blank goal. File: Orchestrator.kt. Rule: ids 1..n in order.` Keep the structured task/result protocol as the source of truth; the compact context is only the worker's situational briefing.
- Done when: each level runs on a different provider in one session.

### 8. Hardening
- Cancellation end-to-end (stream + subprocess + tool run), error surfacing, token/cost display, chat-history persistence.
- Cancellation: `ToolLoop` and `Orchestrator` throw `RunCancelledException` (a `CancellationException`) carrying the partial transcript; every unanswered tool call gets a result (`Outcome uncertain: cancelled; side effects unknown` for the one in flight, `Not executed` for the rest) and `ChatSession` appends `[Cancelled by user]`. Approval dialogs are modeless (M9) and close when the run is cancelled.
- History: one JSON file per project under `<system dir>/stewart/history/`, atomic writes, system messages never stored; `historyRetentionDays` setting (default 30, `0` = do not save); corrupt/unknown-version files are set aside as `.corrupt`; "Clear" in the chat header wipes memory, usage and file.
- Usage/cost: token usage is summed across model turns, compaction requests and failed/cancelled runs, and across requests (session totals shown and persisted). Cost is shown only when the provider reports it (Claude CLI `total_cost_usd`); Ollama/AIF show `cost n/a`, never `$0`. No local price table.
- Errors: provider/loop failure codes map to an actionable hint (`ErrorHints`) shown as an error message in the chat.
- Done when: cancellation stops scheduling, closes streams and terminates owned process trees where supported; atomic IDE edits remain undoable, and completed or uncertain command side effects are reported rather than claimed to be rolled back.

## Assumptions
- Kotlin + Gradle IntelliJ Platform Plugin 2.x; provisional IntelliJ 2025.1+ (build 251) and Java 21, subject to the M1 product compatibility matrix.
- Enterprise Claude Code entitlement, SSO login and CLI isolation passed the M1 feasibility gate on CLI 2.1.309 (see `docs/CLAUDE_FEASIBILITY.md`); managed-policy suppression verified 2026-10-29 on CLI 2.1.312 (canary hook/MCP test; see `docs/CLAUDE_FEASIBILITY.md`).
- Ollama runs locally on default port; no auth.
- The AIF proxy supports native `tools`; native is the default path for `AifProvider`. The shim is deprecated, kept as a per-model fallback, and stays a Kotlin port (no bundled Python sidecar).
- Worker-bee edits require user approval by default (diff preview); terminal commands always require approval.
- Levels talk via structured JSON messages (plan, task, result), not free text.

## Open Questions
1. Managed configuration: can the org's Claude Code policy cause hooks, plugins or MCP servers to run inside the plugin's `claude` subprocess? **Resolved (2026-10-29, CLI 2.1.312):** no. With the exact plugin flags, a project `SessionStart`/`UserPromptSubmit` hook, a project `.mcp.json` server, and the user's own hooks and plugins all stayed inert (no hook events, no canary files, init `tools`/`mcp_servers` empty). The same setup without `--safe-mode`/`--strict-mcp-config`/`--tools ""` fired all of them. No managed settings file exists on this machine (`/etc/claude-code` absent, `~/.claude/remote-settings.json` is `{}`); `policy-limits.json` only restricts remote-control/web-setup. The runtime `isolation_violation` check remains the backstop if a future org policy changes this.
2. Minimum IntelliJ version / which IDEs (IDEA only, or all JetBrains)? Cline targets 251+. All JetBrains IDEs should be supported.
3. Should the Planner be allowed to ask the user questions mid-run (blocking), or only up front? Mid-run questions should be allowed. **Built in M9** (`ask_user`, Planner levels only, `maxQuestions` 3 per run, inline answer prompt).
4. Auto-approve edits option for trusted mode? Yes, auto-approve edits option for trusted mode. **Built** (`autoApproveEdits` setting; terminal commands still always ask).
5. Is per-project history in the plugin state directory sufficient, or is a global history view required? Per-project history in the plugin state directory should be sufficient. 
6. Should ongoing Kotlin/Python shim parity be maintained automatically, beyond the recorded baseline and explicit differences? We will manually update if and when necessary.
7. Do AIF accounts expose a `/models` list, or do model IDs stay user-entered strings? **Built (2026-10-31):** `AifProvider.listModels()` calls `GET <base>/models` and unions the API ids with any configured extra models; missing key → empty list, HTTP/parse failure → `IOException`.

### 9. Post-M8 open items
- Worker dispatch context: `workerBriefing` gives each Worker its own task, files and the results of the tasks it lists in `depends_on` (same round only), bounded to `maxHandoffChars`.
- Mid-run Planner questions: non-terminal `ask_user` tool (Planner initial plan and re-plan only), `UserPrompter`, `OrchestratorListener.onQuestion`, inline `ChatPanel` prompt; Stop cancels the wait (`Not answered: cancelled`).
- Approval dialogs modeless (`DialogHost` seam); cancelling the waiting run closes the dialog.
- `ChatSession.commitIfActive` factors the repeated transcript commit.
- Branch-coverage headroom raised with negative-path tests.
- Done when: `test koverVerify verifyPlugin` pass. See `docs/PROGRESS.md` for hashes.

## Open Items
M1–M10 are done (M10: slash commands, cancel-before-start fix; see `docs/PROGRESS.md`). Remaining:

1. ~~Manual `./gradlew runIde` check: all 8 slash commands, autocomplete Tab/Esc inside the tool window~~ — verified 2026-10-31 in PyCharm.
2. Deferred: `/resume` and `/memory` (history is per-project, so `/resume` is likely redundant). Add only if asked.
3. ~~Requested follow-ups from `docs/todo.txt`~~ — all resolved 2026-10-31: Qwen/AIF edits, Visual Studio feasibility, Nemotron. See below.
4. ~~AIF model discovery~~ (done 2026-10-31). ~~Ollama native tools~~ (done 2026-10-31: `/api/show`/`/api/tags` capability probing, `tools` payload, `NativeToolCalls` parsing, `tool_name`+`tool_call_id` results, `native_tools_unsupported` on explicit 400).

Per-item handoff plans: `docs/HANDOFF.md`.

### Requested follow-ups

**Qwen/AIF edit calls and write verification — resolved 2026-10-31.** `AifEditLiveTest` drives a real `WriteFile`+`EditFile` cycle on `qwen3-8-27b` through preview, approval and post-write read-back, on SHIM and NATIVE paths; approved content verified on disk on both. The reported incompatibility did not reproduce. `EditTool.applyChange` now re-reads the saved file and compares it with the approved `FileChange.after`; a mismatch or missing file fails with uncertain side effects rather than success, and there is no retry. If a future live run surfaces an unmapped Qwen call format, fail closed per the rule below; a CLI write remains a separate, explicitly approved `RunTerminal` action, never an automatic fallback.

**Visual Studio support — resolved 2026-10-31 as feasibility.** Target chosen: Visual Studio Code (not Visual Studio 2022). Decision and plan: `docs/VISUAL_STUDIO.md` — go, as a separate TypeScript repository (`stewart-vscode`) reusing this repo's recorded fixtures as a conformance corpus, phased P1 chat → P2 tools → P3 Claude CLI + orchestration → P4 packaging. Nothing in this repository changes; Scope still excludes non-JetBrains IDEs, and the verifier results here do not cover any VS Code build.

**Nemotron model investigation.** Resolved: Nemotron on the AIF account is `nemotron-3-embed-8b`, embeddings only (HTTP 404 on `/chat/completions`). No chat/tool route exists; nothing to implement unless the account adds a chat Nemotron model.

## References
- `/srv/compose/aif_shim/` — Python shim to port (`aif_shim/parser.py`, `translate.py`, `server.py`), docs + install notes in its `docs/`, test fixtures in `tests/`.
- Cline plugin jar for API/UX patterns: `~/.local/share/JetBrains/PyCharm2025.3/cline/lib/cline-2.0.7.jar` (`META-INF/plugin.xml` shows the extension points in use).
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference — interface documentation, not proof of tenant support.
- Claude Code headless streaming: https://code.claude.com/docs/en/headless — interface documentation, not proof of tenant support.

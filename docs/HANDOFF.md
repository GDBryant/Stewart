# Handoff — outstanding items (post-M10)

State at handoff: `main` @ `189fdb4` plus uncommitted docs and `ToolsProviderMatrixTest`. M1–M10 done (`docs/PROGRESS.md`).
Last recorded gate: 824 tests passed (7 live skipped); `koverVerify` line 96.8%, branch 85.2%. `verifyPlugin` Compatible on IDEA 2025.1 and PyCharm 2025.3 at `5fe43d3` (no platform/UI change since).
The post-M9 handoff (cancel-before-start fix, slash commands) is done; its text is in git history (`0ee6ce2`).

Items, in order. 1–4 are plugin work; 5–6 are investigations that end in a written plan, not code.

| # | Item | Kind |
|---|------|------|
| 1 | ~~Manual `runIde` check of slash commands~~ done 2026-10-31 (installed PyCharm) | done |
| 2 | ~~AIF model discovery from the API~~ done 2026-10-31 | done |
| 3 | ~~Qwen/AIF edit calls + post-write verification~~ done 2026-10-31 — see §3 note | done |
| 4 | ~~Ollama native tools~~ (done 2026-10-31) | feature |
| 5 | ~~Visual Studio support~~ done 2026-10-31 — `docs/archived_v2/VISUAL_STUDIO.md` (VS Code) | feasibility |
| 6 | Nemotron model | investigation |

## Rules for every item (from `AGENTS.md`)
- Tests for the positive and the negative case in the same change.
- `./gradlew test koverVerify` must pass (≥90% line, ≥80% branch).
- `./gradlew verifyPlugin` before any commit that touches `plugin.xml`, UI or platform APIs.
- One commit per item (or slice). Add a line to `docs/PROGRESS.md` with the hash; remove the item from PLAN Open Items and PROGRESS when done.
- Never log or persist the AIF key (`AifCredentials`, PasswordSafe only). Redact bearer tokens in any captured stream.
- Tool calls are data: every path goes through `ToolLoop.executeCall` (validate → preview → approval → execute). No provider executes anything. No same-turn native→shim switch, no replay after execution starts.
- Do not push unless asked.

---

## 1. Manual `runIde` check: slash commands — DONE (2026-10-31)
Verified by the user in PyCharm with the installed plugin: all 8 slash commands and autocomplete (Tab/Esc/Enter/`//` escape, blocked-while-running) work as expected. Original steps kept below for regression reference.
**Why.** M10 shipped with unit tests only; the autocomplete popup and key handling were never exercised in a real tool window.

**Steps.** `./gradlew runIde` (IC 2025.1 sandbox), open the chat tool window, Ollama running locally.
- Each of `/help`, `/clear`, `/cost`, `/config`, `/model`, `/model <id>`, `/compact`, `/init`, `/review` once; `/init` and `/review` need a model and a dirty git file.
- Autocomplete: type `/`, check the list; Tab inserts; Enter on a partial inserts, on a full name runs; Up/Down move; Esc hides until the text changes; a space hides it.
- Mid-run: `/cost` works, `/clear` reports "not available while running", plain text is ignored, the button stops.
- Unknown `/foo` → error, input kept. `//x` is sent as text `/x`.

**Done when** all pass; record the date in `docs/COMPATIBILITY.md` → Manual smoke, and drop Open Item 1 in `docs/archived_v1/PLAN.md`. Any failure becomes a bug item with a failing test first.

---

## 2. AIF model discovery — DONE (2026-10-31)
`AifProvider.listModels()` calls `GET <base>/models` (10 s timeout, `Authorization` header). Missing/blank key → `emptyList()`, no request. HTTP error or malformed/`data`-less body → `IOException` (message redacted). Result is the union of API ids and configured `aifModels`, deduplicated. `AifUrls.models()` joins the URL like `chatCompletions` (no doubling). Settings label renamed to "AIF extra models (one per line)". Live `AifLiveTest.live aif lists models` passed against the account; the picker now shows `nemotron-3-embed-8b`, `qwen3-8-27b`, `glm-5-3-flash` without typing them.

**Original design (kept for reference).**
- `AifUrls.models(base)`: same trimming/validation as `chatCompletions`; `<base>/models`, never doubled. Test URL joining (trailing slash, already-ending-in-`/models`).
- `listModels()`: if the key is missing → `emptyList()` plus no exception (the picker already shows other providers when one fails, `ChatPanel.kt:664`). On HTTP error or parse failure → throw `IOException` with the redacted error, as `OllamaProvider.listModels` does. On success: union of API ids and configured `aifModels` (configured ids stay usable when the list omits them), stable order, no duplicates.
- Timeout 10 s, `Dispatchers.IO`, same `client` as chat.
- Settings UI: rename the label to "AIF extra models (one per line)"; keep the field.
- `ProviderRegistry` snapshot is unchanged (base URL, models, overrides).

**Tests** (`AifProviderTest`, fake `HttpClient` as the chat tests do): success parses ids; union with configured ids; missing key → empty, no call; 401 → `IOException` with redacted message; malformed JSON → `IOException`; URL join cases. Live: extend `AifLiveTest` with a `listModels` call gated by `AIF_LIVE`.

**Done when** the picker shows the account's models without typing them; `verifyPlugin` passes (settings UI touched).

---

## 3. Qwen/AIF edit calls + post-write verification — DONE (2026-10-31)
Resolved: `AifEditLiveTest` drives a real `WriteFile`+`EditFile` cycle on `qwen3-8-27b` on both SHIM and NATIVE paths; approved content verified on disk. The reported incompatibility did not reproduce — the one observed anomaly was the model editing leftover state from a prior run, fixed by unique filenames per run, not a plugin bug. Post-write read-back landed in `EditTool.applyChange` (`ProjectTools.kt`): after `saveDocument` the file is re-read from disk and compared with the approved `FileChange.after`; mismatch/missing file throws `IllegalStateException` reporting uncertain side effects — no silent success, no retry. Tests cover success (existing write/edit tests), mismatch, missing file, stale preview and cancellation. The investigation plan below is kept for reference; only §3d remains latent policy if an unmapped format ever appears.

### Original investigation plan (kept for reference)
**Report (unreproduced).** "Edit file tool calls from AI Factory > Qwen are not all compatible with the JetBrains IDE." Native AIF was live-tested on `glm-5-3-flash` only. `AifLiveTest` (zero-arg tool) passes on `qwen3-8-27b` on both SHIM and NATIVE paths, so 3a must use the real `EditFile`/`WriteFile` flow. Otherwise nothing about the reported failure is known yet: not which call format, not whether it is in the stream, the parser, validation, approval or the write.

### 3a. Reproduce (no code changes)
- Disposable project (not this repo). Settings: AIF base URL, Qwen model id in `aifModels`, no override (native). Enable tools, trusted mode off.
- Ask for: (1) create a new file (`WriteFile`), (2) replace one line (`EditFile`), (3) replace a string that occurs twice (expects the ambiguity error), (4) edit a file outside the project (expects rejection).
- Capture per attempt: the raw SSE lines (temporarily via a test `HttpClient` wrapper or `AIF_LIVE` test, **redact `Authorization`**), the `ToolCall`s emitted by `ToolCallingProvider`, the `ToolOutcome` from `LoopListener.onToolOutcome`, and the file before/after.
- Repeat with `toolPathOverrides["aif/<qwen>"] = "SHIM"`.
- Classify each failure as one of:
  - **A. stream/parse** — `NativeCallCollector`/`StreamTranslator` drops or mangles the call (e.g. arguments split oddly, `arguments` sent as an object rather than a string, missing `id`, a Qwen-specific tag format);
  - **B. schema** — the model invents arguments or tool names (`ToolRegistry.validate` → `Invalid tool call`), e.g. `old_str`/`new_str`, `file_path`, `content` on `EditFile`, `replace_all` as a string;
  - **C. preview** — `old_string` not found / ambiguous / empty (`EditFile.preview`);
  - **D. write** — approved but the IDE write failed or the file does not contain `after`.
- Write the findings (redacted samples, one per class seen) into `docs/QWEN_EDITS.md` before fixing anything.

### 3b. Fix by class
- **A:** add the verbatim sample as a fixture to `ToolCallParserTest`/`StreamTranslatorTest` (positive) plus a near-miss negative; fix the parser/collector. New format → `docs/archived_v1/SHIM_PARITY.md` intentional-differences entry. Never accept an incomplete call.
- **B:** do **not** loosen `additionalProperties=false`. Options, in order: (i) tighten the tool descriptions in `ProjectTools.kt` specs (name the exact argument names, give one example); (ii) add a role-independent note to the system prompt for the tools path; (iii) only if the same alias recurs across models, add an alias normalisation in `ToolCallParser` (like the existing `RunTerminal` aliases, `docs/archived_v1/SHIM_PARITY.md` §1) with verbatim tests. Rejected calls already return `Invalid tool call: …` to the model so it can retry within the turn budget.
- **C:** usually a model error (stale content). Make the error text actionable ("read the file again and copy the exact text"); no behaviour change.
- **D:** see 3c.

### 3c. Post-write verification (do this regardless of 3a's result)
- In `EditTool.applyChange` (`tools/ProjectTools.kt:234`), after `saveDocument(doc)` (`:294`): read back `doc.text` and `Files.readString(path)`; both must equal `change.after`. On mismatch throw `IllegalStateException("write verification failed: <which> differs; side effects possible")`. `ToolLoop` turns this into `Error: …` for the model; the UI already shows failures.
- Keep it inside the same `WriteCommandAction` so the undo unit is unchanged (`ProjectToolsTest` "approved edit is a single undoable command" must still pass).
- No automatic retry, no second write. The model may ask again; that produces a fresh preview and approval.
- Tests (`ProjectToolsTest`, `BasePlatformTestCase`): success unchanged; simulated mismatch (a test-only hook that mutates the document after `setText`, or a `VirtualFileListener` that rewrites on save) → failure message, file left as written, result reported as failure not success; missing-preview and stale-preview errors unchanged; cancellation during apply → `Uncertain` as today (`ToolLoopCancelTest`).

### 3d. CLI write path — only if 3a shows a call that cannot be mapped safely
Not a fallback. If a model's edit call cannot be mapped (class A unfixable or class B with no stable alias), the correct outcome is the existing `Invalid tool call` result; the model can then use `RunTerminal`, which previews the exact command and cwd and always asks. Do not add a hidden "interpret and run via CLI" step: it would skip the diff preview, undo and `before`/`after` checks. If the user still wants a CLI write tool, it is a new approval-gated tool with its own preview and tests, scoped in a separate handoff.

**Done when** each class seen in 3a has a fixture and a fix (or a documented "model error, message improved"); 3c lands with tests; a live Qwen cycle (read → `EditFile` approved → verified on disk) and a later-turn shim cycle both pass in the disposable project; malformed/rejected calls made no change. Record the Qwen model id and date in `docs/COMPATIBILITY.md` → AIF live check.

---

## 4. Ollama native tools
**Done 2026-10-31** (`00ed330`). `OllamaProvider` probes `tools` capability via `/api/tags` (with `/api/show` fallback), sends OpenAI-shape `tools`, parses `NativeToolCalls`, sends `tool_call_id`+`tool_name` results; `ollama` added to `NATIVE_CAPABLE`. The design below is historical context.

**To verify first.** Against the local Ollama: `GET /api/show` with `{"name": "<model>"}` returns a `capabilities` array containing `"tools"` on recent servers; `POST /api/chat` with `tools` returns `message.tool_calls[].function.{name, arguments}` where `arguments` is a JSON **object** (not a string as in OpenAI); models without tool support answer HTTP 400 "… does not support tools". Confirm all three on the installed version and record the server version in `docs/COMPATIBILITY.md`.

**Design.**
- Capability: `supportsNativeTools(model)` from a per-provider cache filled on `listModels()` via `/api/show` per model (parallel, 10 s timeout). Unknown/failed lookup → `false` (shim), matching the execution contract "unknown capability uses the shim". An explicit `NATIVE` override on an unsupported model still fails with `native_tools_unsupported` (`ToolCallingProvider.kt:43`) — keep that.
- Request: when `request.tools` is non-empty, send `tools` in OpenAI function shape (same builder as `AifProvider.kt:96`). Ollama has no `tool_choice`; if `toolChoice` is `Required`/`Specific` and the model returns no call, let the existing `toolPolicyError` path report it. `parallel_tool_calls` is ignored.
- Response: `OllamaNdjson.parseLine` emits `ProviderEvent.NativeToolCalls` when `message.tool_calls` is present; `arguments` object → serialised string for `RawToolCall`; synthesise ids `call_<n>` when absent (Ollama omits them), unique within the turn. Tool results go back as `role: "tool"` messages with `tool_call_id` where supported; verify the field name the server accepts.
- HTTP 400 "does not support tools" → `Failed(code = "native_tools_unsupported")`, no retry on the shim in the same turn (contract). The user may set a `SHIM` override.
- Add `"ollama"` to `ToolPathResolver.NATIVE_CAPABLE`: `StewartConfigurable.kt:80` rejects a `NATIVE` override for any provider outside that set, so without this the per-model override cannot be set. Update `ToolPathResolverTest`.

**Tests.** `OllamaNdjsonTest`: tool_calls line (object arguments, missing id, two calls, `done` on a later line), malformed tool_calls (no name) → `Failed`, 400 body → `native_tools_unsupported`. `OllamaProviderTest` (fake `HttpClient`): payload contains `tools` only when offered; capability cache true/false/unknown. `ToolCallingProviderTest`: native path drives the fake tool; shim unchanged for a non-capable model. `ToolsE2ETest`: native read + approved edit + approved command with a fake Ollama (closes the M5 "each path" matrix together with AIF native). Live: `OllamaLiveTest` native variant gated by `OLLAMA_LIVE` and `OLLAMA_TOOL_MODEL`.

**Done when** a tool-capable local model edits with approval on the native path and a non-capable one still works on the shim; `verifyPlugin` passes if settings UI changed.

---

## 5. Visual Studio support — DONE (2026-10-31)
Written up in `docs/archived_v2/VISUAL_STUDIO.md`. The user chose Visual Studio Code (not Visual Studio 2022); recommendation is go, as a separate TypeScript repo (`stewart-vscode`) reusing this repo's recorded fixtures, phased P1 chat → P2 tools → P3 Claude CLI + orchestration → P4 packaging. No code here; Scope still excludes non-JetBrains IDEs. The original feasibility questions are kept below for reference.
Visual Studio is not a JetBrains host: the IntelliJ Platform ZIP, `plugin.xml`, VFS/PSI, `WriteCommandAction`, `PasswordSafe` and the Swing tool window do not exist there. This item ends in a written plan and a go/no-go, not code in this repo.

**Questions to answer** (write to `docs/archived_v2/VISUAL_STUDIO.md`):
1. Target: Visual Studio 2022 (VSIX, .NET, Windows) vs Visual Studio Code (extension, TypeScript, cross-platform). The todo says "Visual Studio"; confirm with the user — the two share nothing.
2. What is portable: provider protocols (Ollama NDJSON, AIF SSE, Claude CLI stream-json) and the tool-call parser/translator (a Python reference already exists at `/srv/compose/aif_shim`); the orchestration protocol (`submit_plan`/`submit_tasks`/`submit_result`/`ask_user` JSON schemas). What is not: everything under `tools/` (VFS, documents, undo), `ui/`, `settings/`.
3. Host equivalents needed: secret store, undoable document edits, diff preview + approval UI, cancellable process runner, per-project history location.
4. Packaging/signing/distribution and the test story (both hosts have test harnesses; coverage gates must be re-established).
5. Effort by option: (a) separate repo, port in the host's language; (b) shared core as a local HTTP/stdio service in Kotlin reused by a thin host extension (adds a process and a protocol to maintain); (c) decline for now.

**Done when** the doc exists with a recommendation and the user has chosen; nothing in this repo changes except PLAN Scope if the user widens it.

---

## 6. Nemotron model (resolved)

Nemotron on the AIF account is `nemotron-3-embed-8b`, an embeddings-only model — `POST /chat/completions` returns HTTP 404 `{"detail":"Not Found"}`. No chat/tool route exists; nothing to implement unless the account adds a chat Nemotron model. `docs/NEMOTRON.md` is not needed.


---

## After the items
- `docs/PROGRESS.md`: one line per item with hash, test count, coverage.
- `docs/archived_v1/PLAN.md` → Open Items: remove done items; Open Question 7 → **Built** once item 2 lands; path table → confirm Ollama row once item 4 lands.
- `./gradlew buildPlugin verifyPlugin`, then `scripts/install-plugin.sh --no-build` and a manual smoke test.

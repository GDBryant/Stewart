# Phase 2 Plan — Gaps & Multi-Layered Agent Improvements

## 1. Phase 1 Build & Plan Audit

**Build state:** `./gradlew check` passes (824 tests, 0 failures, 7 live skipped; Kover ≥90% line / ≥80% branch; `verifyPlugin` Compatible on IDEA 2025.1 and PyCharm 2025.3). Milestones M1–M10 and the post-M10 handoff items are complete.

### Missing from `docs/PLAN.md` (Phase 1 gaps)

| Area | Plan reference | Current codebase state | Impact |
|---|---|---|---|
| **Planner / Executor read-only tools** | M6/M7: Planner plans, Executor dispatches and verifies milestones (`Orchestrator.kt:54,64,315,368`) | Planner has only `submit_plan` + `ask_user`; Executor has only `submit_tasks` + `complete_milestone`. Neither has `ReadFile`, `FindFiles`, or `Search`. | Planner plans blind without inspecting repo layout; Executor cannot verify Worker claims before calling `complete_milestone` and must either trust the Worker summary or burn a full Worker round just to read/check a file. |
| **Orchestrator UI visibility** | M6/M7: structured plan/task/result messages and tool visibility (`ChatSession.kt:381-383`, `Orchestrator.kt:534-536`) | `OrchestratorListener.onPlan`, `onTasks`, and `onResult` are no-ops in `ChatSession`. `Orchestrator.runLevel` creates a `LoopListener` that forwards only `onText`, dropping `onToolRequested`, `onToolOutcome`, `onReasoning`, `onCompacted`, and `onCompactionFailed`. | In multi-model mode, users see raw text deltas and level headers, but never see Worker tool calls/outcomes, structured plans, task lists, or reasoning in the chat panel. |
| **Subprocess proxy/cert propagation** | Persistence §91 (`PLAN.md:91`): *"configure and validate the subprocess network environment separately, since the CLI does not inherit IDE HTTP settings"* | `IdeHttpClients` configures Java `HttpClient` for Ollama/AIF, but `ClaudeProvider.childEnv()` (`ClaudeProvider.kt:54`) only copies `System.getenv()` + `extraEnv` without translating IDE HTTP proxy / SSL cert settings into `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS`. | Claude CLI fails behind corporate proxies configured only in IDE settings. |
| **Editor actions & intentions** | Reference §14 (`PLAN.md:14`): editor popup action *"Add to chat"* and intention actions (*explain/fix*) | `plugin.xml` registers only the toolWindow and `applicationConfigurable`. No editor popup actions, intention actions, or active-editor context injection exist. | Users must manually copy-paste file paths, line ranges, and stack traces into chat. |
| **IDE Terminal mirroring** | Reference §14 & M5 (`PLAN.md:14,130`): optional `org.jetbrains.plugins.terminal` dependency to mirror `RunTerminal` output | `RunTerminal` captures output via `ProcessBuilder`/`GeneralCommandLine` into the chat message only; no optional terminal dependency or mirroring. | Long-running test/build commands have no live streaming terminal view. |
| **Project memory injection (`/memory` & `AGENTS.md`)** | Open Items (`PLAN.md:182`) & `/init` (`InitFiles.kt`) | `/init` creates `AGENTS.md` and `docs/ai_docs/MEMORY.md`, but neither `ChatSession` nor `Orchestrator` automatically loads them into the system prompt on session start, and `/memory` is unimplemented. | Project conventions written by `/init` are ignored in later sessions unless the model happens to read `AGENTS.md` via `ReadFile`. |
| **Reasoning deltas in UI** | M2 (`PLAN.md:66`, `ToolLoop.kt:40,178`) | `ProviderEvent.ReasoningDelta` is parsed from `think`-tag blocks and native `reasoning_content`, and passed to `LoopListener.onReasoning`, but `ChatSession` and `ChatPanel` ignore it. | Thinking/reasoning models (Qwen, DeepSeek, Claude) appear frozen during long reasoning chains. |

---

## 2. Gaps in the Phase 2 Plan Itself (decisions to lock before coding)

| # | Gap | Evidence | Resolution |
|---|---|---|---|
| **G1** | Effort presets would *regress* current behaviour: `MEDIUM` (the stated default) is lower than today's limits. | Today: `maxMilestones=8, maxTaskRounds=3, maxReplans=2, maxLevelModelTurns=15, maxQuestions=3` (`Orchestrator.kt:117-127`); single-model loop is a hardcoded `maxModelTurns=25` (`ChatSession.kt:236`). | `MEDIUM` **is** the current limits; `LOW`/`HIGH`/`MAX` fan out from there. No default-behaviour change when the setting is absent. |
| **G2** | Effort has no transport: `ChatRequest` has no effort field, so providers cannot receive it. | `ChatRequest(model, messages, tools, toolChoice, parallelToolCalls)` (`ModelProvider.kt:43-49`); built at `ToolLoop.kt:171` and rebuilt by the shim at `ToolCallingProvider.kt:51`. | Add `val effort: EffortLevel? = null` to `ChatRequest`; `ToolLoop` sets it, `ToolCallingProvider` must copy it into `innerReq`. |
| **G3** | Claude `--effort` is **not a documented CLI flag**; passing an unknown flag makes the CLI exit non-zero and the whole turn fails. | argv built at `ClaudeProvider.kt:76-81`; any extra arg aborts the process. | Feature-detect once per CLI path (`claude --help` probe, cached), pass the flag only if present, otherwise no-op. Live-test gate: `CLAUDE_LIVE=1` run before shipping. |
| **G4** | Provider effort support is model-specific, not provider-wide: AIF `reasoning_effort` and Ollama `think` are rejected/ignored by non-reasoning models. | Ollama capability probe already exists (`OllamaProvider.kt:101-118`, `capabilities` array); AIF has no capability list. | Ollama: send `think` only when `capabilities` contains `"thinking"`. AIF: send `reasoning_effort` only for models listed in a new optional setting (`aifReasoningModels`), empty by default → never sent. Unknown → omit the field (safe). |
| **G5** | Exclusivity is planned as UI-only, but routing still lets a disabled selector win: the main picker overwrites `plannerModel`, and unset roles fall back to the chat selection. | `ChatPanel.kt:209` (`if (s.multiModel) s.plannerModel = ref`); `RoleRouting.kt:32` (`configured[role] ?: chatRef`). | Delete the overwrite; in multi mode seed each unset role from `chatModel` **once** when the toggle turns on, then require an explicit ref per role and fail with `Unresolved("No model selected for planner")` instead of falling back. |
| **G6** | `RolesPanel` writes settings only when the popup closes, so the main combo cannot re-enable live while the popup is open. | `ChatPanel.kt:212-224` (`apply()` in `onClosed` only); `RolesPanel.kt:50,102-107`. | Add `RolesPanel.onMultiModelChanged: (Boolean) -> Unit` fired on checkbox toggle: writes `s.multiModel`, broadcasts `AijbSettings.TOPIC`, and `ChatPanel` re-runs `updateSelectorState()`. Popup close still applies the three model refs. |
| **G7** | `/model` cannot address a role, but in multi mode the single picker is disabled. | `SlashCommands.kt:187` + `CommandContext.selectModel(model)` (`SlashCommands.kt:25`). | `/model` with no args in multi mode lists the three bindings; `/model <role> <provider/model>` sets one role. Requires `CommandContext.selectRoleModel(role, model)` and `roleModels()`. Reject role args in single mode and bare model args in multi mode. |
| **G8** | Settings surface is incomplete: the plan names only `ChatPanel`/`RolesPanel`, but a persisted default effort also needs the settings dialog, and mode changes need a broadcast. | `AijbConfigurable.kt` has no effort row; `AijbSettings.TOPIC` is broadcast only from `apply()` (`AijbConfigurable.kt:202-203`). | Add an "Effort" combo to `AijbConfigurable` (`row("Agent effort:")`), include it in `isModified`/`reset`/`apply`, and broadcast `TOPIC` from `RolesPanel.onMultiModelChanged`. |
| **G9** | Hardcoded limit strings leak into user-visible errors. | `ChatSession.kt:264`: `"Stopped: tool-turn limit reached (25)"`. | Interpolate the resolved limit; same for orchestrator limit messages. |
| **G10** | Per-role effort needs a storage key and an inheritance rule; the plan says "optional per-role override" without a format. | `AijbSettings.State` (`AijbSettings.kt:20-36`). | `var effort by string("MEDIUM")` and `var roleEffort by map<String, String>()` keyed by `AgentRole.name`; absent/blank = inherit global. Overrides are honoured only when `multiModel` is on. |
| **G11** | Mid-run changes are undefined: mutating limits while an `Orchestrator` runs would be read per level. | `Orchestrator` captures `limits` at construction (`Orchestrator.kt:268`), but `ChatSession` builds them per run (`ChatSession.kt:392-405`). | Effort applies to the **next** run only; `/effort` is `allowedWhileRunning = false`. Documented in `/help` output. |
| **G12** | Effort interacts with compaction; higher turns means bigger context. | `LoopLimits.compactAtTokens` from `autoCompactTokens` (`ChatSession.kt:238`), `maxContextChars` (`ToolLoop.kt:51`). | Compaction thresholds stay **fixed** (user-owned setting), not effort-scaled. Explicitly out of scope so token cost stays predictable. |
| **G13** | Existing tests assert the literal numbers being replaced. | `LoopLimits` defaults (`ToolLoop.kt:47-55`), orchestrator limit tests, `SlashCommands.help()` assertions, `RolesPanel`/`ChatPanel` tests. | Treat as part of the change: update the literals, add positive+negative tests per the repo rule, keep `koverVerify` green. |
| **G14** | Milestone M11 is too large for one reviewable change (UI + routing + settings + providers + limits). | — | Split into M11.1–M11.4 below, each independently shippable with tests. |
| **G15** | The plan has no stated status surface, so a user cannot tell which mode/effort/route is live. | `ChatPanel.statusLabel` (`ChatPanel.kt:180`). | Status line shows `mode=single|multi · effort=MEDIUM · <route>`; in multi mode `planner→…, executor→…, worker→…`. |

---

## 3. P2.1 / M11 — Effort Controls & Exclusive Role Selection (implementation spec)

### 3.1 Data model — `settings/EffortLevel.kt` (new)

```kotlin
enum class EffortLevel { LOW, MEDIUM, HIGH, MAX }

object EffortPresets {
    data class Budget(
        val maxMilestones: Int, val maxTaskRounds: Int, val maxReplans: Int,
        val maxLevelModelTurns: Int, val maxQuestions: Int, val maxModelTurns: Int,
    )
    fun budget(level: EffortLevel): Budget = when (level) {
        LOW    -> Budget(3, 1, 0,  6, 0,  8)
        MEDIUM -> Budget(8, 3, 2, 15, 3, 25)   // == today's defaults
        HIGH   -> Budget(12, 4, 3, 22, 4, 40)
        MAX    -> Budget(16, 6, 5, 30, 6, 60)
    }
    fun parse(raw: String?): EffortLevel? = ...
    fun orchestratorLimits(level: EffortLevel, base: OrchestratorLimits = OrchestratorLimits()): OrchestratorLimits
    fun loopLimits(level: EffortLevel, compactAtTokens: Int?): LoopLimits
}
```

Fixed (not effort-scaled): `maxTasksPerRound=10`, `toolTimeout`, `maxHandoffChars`, `maxToolOutputChars`, `maxContextChars`, `compactAtTokens`, `maxTruncationRetries`.

### 3.2 Settings (`AijbSettings.kt`)

- `var effort by string("MEDIUM")` — global default; unknown value falls back to `MEDIUM`.
- `var roleEffort by map<String, String>()` — key `AgentRole.name`, value `EffortLevel` name; absent = inherit.
- `fun effortFor(role: AgentRole): EffortLevel` — returns `roleEffort[role.name]` when `multiModel` and set, else global.
- New fields need no migration (BaseState defaults apply); existing `aijb-assistant.xml` files keep working.

### 3.3 UI

**`ChatPanel`**
- Header: `effortCombo: JComboBox<EffortLevel>` next to `modelCombo`; on change → `s.effort`, broadcast `TOPIC`, refresh status line. Tooltip states the resulting budgets.
- `internal fun updateSelectorState()` — single source of truth, called from `init`, `loadModels()`, `RolesPanel.onMultiModelChanged`, and `TOPIC` subscriber:
  - `multiModel == false`: `modelCombo.isEnabled = true`; `rolesButton` enabled, its 3 combos disabled.
  - `multiModel == true`: `modelCombo.isEnabled = false`; 3 combos enabled.
- `onModelSelected()` (`ChatPanel.kt:205-210`): drop the `plannerModel` overwrite; persist only `chatModel`.
- Status line: `mode=… · effort=… · route…` (G15).

**`RolesPanel`**
- `onMultiModelChanged: (Boolean) -> Unit = {}` fired from `multiModelCheck`; writes `s.multiModel`, seeds unset roles from `chatModel`, broadcasts `TOPIC`.
- Per-role effort combo per row (`Planner effort`, `Executor effort`, `Worker effort`) with items `inherit` + 4 levels; enabled only when the multi checkbox is on; `apply()` writes `roleEffort`.
- Keep the `(chat selection)` item **only** for the seeding path; in multi mode an unset role is a routing error (G5).

**`AijbConfigurable`**
- `row("Agent effort:")` combo + `roleEffort`-free (per-role stays in `RolesPanel`), wired into `isModified`/`reset`/`apply` (G8).

**`SlashCommands`**
- `SlashCommand("effort", "[low|medium|high|max]", "Set agent effort for the next run", allowedWhileRunning = false)`; no arg → report global + per-role values. Unknown arg → `ctx.error` and keep input.
- `/model`: role-aware as in G7.
- `/help` text grows by two lines → update help assertions.

### 3.4 Routing & execution

- `RoleRouting.resolve` (`RoleRouting.kt:24-40`): drop the `?: chatRef` fallback in multi mode; unresolved role → `Unresolved("No model selected for <role>")`. Keep `chatRef` as the parameter for the seeding path only.
- `ChatSession.send` (`ChatSession.kt:210-241`): single mode builds `LoopLimits` from `EffortPresets.loopLimits(effort, autoCompactTokens())` instead of the literal 25; turn-limit message interpolates the limit (G9).
- `ChatSession.runOrchestrator` (`ChatSession.kt:392-405`): pass `limits = EffortPresets.orchestratorLimits(effort)`; `Orchestrator` needs no signature change (already accepts `limits`).
- `Orchestrator.runLevel` (`Orchestrator.kt:541-542`): keep `maxModelTurns = limits.maxLevelModelTurns`; per-role effort may later override per level — out of scope for M11 (single global + per-role preset only).
- `ChatSession.effort`/`roleEffort` seams: `var effort: () -> EffortLevel` and `var effortForRole: (AgentRole) -> EffortLevel` (same pattern as `multiModel`, `ChatSession.kt:77`) so tests can inject without a real `AijbSettings`.

### 3.5 Provider forwarding

- `ChatRequest.effort: EffortLevel? = null` (`ModelProvider.kt:43-49`).
- `ToolLoop` sets it from `LoopLimits`-adjacent state (new `ToolLoop` ctor param `effort`, default null) at `ToolLoop.kt:171`.
- `ToolCallingProvider` copies it into `innerReq` (`ToolCallingProvider.kt:51`).
- `AifProvider` (`AifProvider.kt:120-140`): add `put("reasoning_effort", "low"|"medium"|"high")` only when `request.effort != null` **and** the model is in `aifReasoningModels`; `MAX` maps to `"high"`.
- `OllamaProvider` (`OllamaProvider.kt:120-166`): add `put("think", false|true)` only when the `/api/show` capabilities contain `"thinking"`; `LOW → false`, else `true`.
- `ClaudeProvider`: probe `--help` once (cached per CLI path), append `--effort <level>` only if supported (G3).
- Compaction requests (`ContextCompactor`) keep `effort = null`.

### 3.6 Task order

| Step | Scope | Exit gate |
|---|---|---|
| **M11.1** | `EffortLevel`, `EffortPresets`, settings fields, `effortFor`, unit tests for every preset and unknown-value fallback | `./gradlew test` |
| **M11.2** | Exclusive selectors: `ChatPanel.updateSelectorState`, remove `plannerModel` overwrite, `RolesPanel.onMultiModelChanged` + live enable, `RoleRouting` no-fallback, `/model <role>` | tests for both modes + routing failure |
| **M11.3** | Effort UI + `/effort` + status line + `AijbConfigurable` row | tests + `./gradlew verifyPlugin` |
| **M11.4** | Provider forwarding (`ChatRequest.effort`, shim copy, AIF/Ollama/Claude gates) + live smoke | tests + `OLLAMA_LIVE`/`AIF_LIVE`/`CLAUDE_LIVE` where available |

### 3.7 Test matrix (positive + negative, per repo rule)

| Area | Positive | Negative |
|---|---|---|
| Presets | `MEDIUM` equals legacy defaults; each level monotonic in all six bounds | unknown/blank setting → `MEDIUM`; parse of `"turbo"` → null |
| Settings | `effortFor` returns role override in multi mode | override ignored when `multiModel == false`; absent key inherits |
| Selectors | multi off → main enabled, 3 disabled; multi on → inverse | toggling twice restores original state; disabled combo selection does not change `chatModel` |
| Routing | multi mode resolves 3 distinct refs | unset role → `Unresolved`, no silent fallback to chat model |
| `/model` | `/model planner claude/sonnet` binds planner | bare model arg in multi mode → error; role arg in single mode → error; blocked while running |
| `/effort` | sets global; reports all four values | invalid arg → error, input kept; blocked while running |
| Limits | single loop uses preset `maxModelTurns`; turn-limit message shows it | effort change mid-run does not alter the running run |
| Providers | AIF sends `reasoning_effort` for a listed model; Ollama sends `think` when capability present; Claude appends `--effort` when the probe says so | AIF omits it for unlisted models; Ollama omits it without the capability; Claude omits it when unsupported; `effort = null` → payload/argv unchanged |

---

## 4. Remaining Phase 2 Work Packages

### P2.2 — Context-Aware Planner & Verifying Executor (Core Orchestration)
1. **Read-only tools for Planner and Executor:** grant `ReadFile`, `FindFiles`, `Search` to `PLANNER` and `EXECUTOR` (never `WriteFile`/`EditFile`/`RunTerminal`). Implementation: a `ToolRegistry` subset per role in `Orchestrator.runLevel` (`Orchestrator.kt:310-315`); the approval gate is bypassed only for read-only tools, matching `ProjectTools` read semantics.
2. **Pre-seeded Worker file slices:** `WorkerBriefing` currently lists `Files: a.kt, b.kt` by name. Inline bounded excerpts (e.g. ≤120 lines / ≤8 KB per file, ≤24 KB total) for `task.files`, with a truncation marker. Oversized → name only.
3. **Cross-milestone dependency memory:** `results` resets per milestone (`Orchestrator.kt:334`) and `replan` passes `emptyList()` (`Orchestrator.kt:458`). Pass a compact `finished` summary (milestone title + files touched + one-line outcome, bounded by `maxHandoffChars`) into later milestones and re-plans.
4. **Parallel Worker execution for disjoint tasks:** tasks in a round with disjoint `files` and satisfied `depends_on` run concurrently (`coroutineScope` + `async`); read-only tools parallel, `WriteCommandAction` serialized on the EDT; failures still produce one result per task.
5. **Interactive Plan Approval Gate:** after `onPlan(plan)`, an optional card in `ChatPanel` to approve / edit milestones / reject before the Executor dispatches. Rejection ends the run with a clear code, not an error dialog.

### P2.3 — Orchestrator Observability & Rich UI
1. **Wire Worker events:** `Orchestrator.runLevel`'s `LoopListener` (`Orchestrator.kt:534-536`) forwards `onToolRequested`, `onToolOutcome`, `onReasoning`, `onCompacted`, `onCompactionFailed` to `OrchestratorListener`, tagged with `AgentRole` + task id; `ChatSession` maps them onto the existing `ChatListener` callbacks.
2. **Structured Plan/Task/Result rendering:** implement `onPlan`/`onTasks`/`onResult` (`ChatSession.kt:381-383`) and render milestone checklists with `pending|running|done|failed` badges.
3. **Collapsible Reasoning & Tool blocks:** replace flat `JTextArea` items with collapsible panels for reasoning, tool arguments/outputs, and Worker sub-transcripts; Markdown/code-block rendering with Copy/Apply.
4. **Per-role usage:** `Map<AgentRole, Usage>` in `Orchestrator`, surfaced by `/cost` (Planner / Executor / Worker split).

### P2.4 — IDE-Native Tools & Context
1. **`GetProblems`:** expose `WolfTheProblemSolver`/`DaemonCodeAnalyzer` highlights; after `EditFile`/`WriteFile`, append new syntax/compiler errors for the edited file to the tool result so the Worker self-corrects without a full build.
2. **PSI symbol tools:** `FindSymbol`, `FindUsages`, `FileOutline` under read actions, complementing the linear VFS `Search` (`ProjectTools.kt:134`).
3. **Multi-hunk `ApplyPatch`:** `EditFile` replaces one `old_string` (`ProjectTools.kt:343`); add an atomic multi-edit with one diff preview and one undoable `WriteCommandAction`.
4. **Auto-loaded memory:** inject bounded root `AGENTS.md` + `docs/ai_docs/MEMORY.md` into the per-request system prompt; add `/memory` to view/edit durable facts.
5. **Editor actions & `@`-mentions:** register "Add Selection to AIJB Chat", "Explain Code", "Fix Problem" in `plugin.xml`; `@file`, `@selection`, `@problems` completion in the input area.

### P2.5 — Provider Resilience & Enterprise Readiness
1. **Claude CLI proxy/cert env:** bridge `JdkProxyProvider` + `CertificateManager` into `ClaudeProvider.childEnv()` (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`).
2. **Streaming `RunTerminal`:** stream stdout/stderr chunks to the UI while running (`ProjectTools.kt:417`), optionally mirrored into the IDE Terminal tool window (optional `org.jetbrains.plugins.terminal` dependency).
3. **Transient error backoff:** bounded exponential backoff for 429/502/503/504 in `AifProvider`/`OllamaProvider`/`ClaudeProvider`, honouring cancellation.
4. **Multi-session history & `/resume`:** named conversations per project instead of one overwritten `ChatHistoryStore` file, selectable by header dropdown or `/resume`.
5. **Approval bypass modes (per tool category):** every approval dialog (`FileApprovalDialog`, `CommandApprovalDialog`, `GenericApprovalDialog` in `ui/ApprovalDialogs.kt`) gains three choices instead of Approve/Reject only: **Approve once**, **Allow for this session**, **Allow always**. Scope is per tool category, not per call — file edits (`ToolPreview.FileChange`), shell commands (`ToolPreview.Command`), and a generic bucket for everything else. "Session" grants live in `IdeApprovalGate`'s in-memory set (cleared on project close / session end); "always" grants persist in `AijbSettings.State` (e.g. `alwaysAllowEdits`, `alwaysAllowCommands`, `alwaysAllowOther`) and subsume today's boolean `autoApproveEdits`. `IdeApprovalGate.review` short-circuits before prompting when the category is granted in either set. Settings page gets checkboxes to view/revoke "always" grants; `/approve` (or a `/permissions`) command lists and clears grants. Security note: "always" for commands must be opt-in per project and visibly indicated in the status line while active.

---

## 5. Proposed Phase 2 Milestones

| Milestone | Scope | Acceptance Criteria |
|---|---|---|
| **M11. Effort Controls & Exclusive Role UI** | M11.1 effort presets + settings; M11.2 exclusive single vs. 3-role selectors enforced in UI *and* routing, `/model <role>`; M11.3 header effort picker, per-role effort, `/effort`, settings row, status line; M11.4 provider effort forwarding (`ChatRequest.effort`, AIF `reasoning_effort`, Ollama `think`, Claude `--effort` behind a feature probe). | `MEDIUM` reproduces today's limits; toggling multi-model mutually excludes main vs. 3-role selectors and a disabled selector can never affect a run; effort changes bounds and provider payloads; `/effort` and `/model <role>` validated; `koverVerify` & `verifyPlugin` pass. |
| **M12. Orchestrator Visibility & Grounding** | Forward Worker tool/reasoning/compaction events; render `onPlan`/`onTasks`/`onResult`; `ReadFile`/`FindFiles`/`Search` for Planner & Executor; milestone summaries across milestones and re-plans; per-role `/cost`. | Multi-model run shows live Worker tool calls and plan progress; Planner/Executor can read files; later milestones see earlier outcomes; `koverVerify` & `verifyPlugin` pass. |
| **M13. Project Memory & Editor Integration** | Auto-inject `AGENTS.md` + `docs/ai_docs/MEMORY.md`; `/memory`; editor "Add to Chat" + quick-fix intentions; `@file` / `@selection` / `@problems`. | `/init` output is active on the next session; editor selection attaches to chat; `verifyPlugin` passes on IDEA & PyCharm. |
| **M14. PSI & Diagnostics Tools** | `GetProblems` + post-edit diagnostics; `FileOutline`/`FindUsages`; multi-hunk `EditFile`/`ApplyPatch`; pre-seeded file excerpts in `WorkerBriefing`. | Worker sees IDE errors immediately after an edit; a multi-hunk edit previews and undoes as one command. |
| **M15. Parallel Workers, Plan Gate & Enterprise Hardening** | DAG-scheduled parallel Workers; interactive plan approval/edit; approval bypass modes (once / session / always per tool category); streaming `RunTerminal`; collapsible reasoning/tool blocks; Claude proxy/cert env; 429/5xx backoff; `/resume`. | Disjoint tasks run concurrently without conflicting `WriteCommandAction`s; session and persisted grants suppress the matching approval dialogs and are revocable; corporate proxy settings reach the Claude CLI; sessions resume. |

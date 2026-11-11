# Stewart — Architecture Now

Living description of the code **as it is**. Update in the same commit as any change to modules, run paths, protocol, config, or host wiring. Plans live elsewhere (`docs/building/` = active; `docs/archived_v2/` = superseded v2-era plans).

Last updated: 2026-11-11 (history: `git log -- docs/ai_docs/ARCHITECTURE_NOW.md`). Planned work: `docs/building/ARCHITECTURE_IMPROVEMENTS.md`, `docs/building/ARCHITECTURE_REFACTORING.md` (R3 partial).

## 1. Layout

```
packages/
  protocol/    JSON-RPC types, PROTOCOL_VERSION, capability negotiation (src/index.ts)
  core/        all logic; no host imports
  sidecar/     Node stdio JSON-RPC server for JetBrains (rpc.ts, server.ts, host.ts reverse-RPC → HostPort, debugSink.ts)
  webview/     Preact chat + settings + setup wizard, one bundle for both hosts (state.ts Store + stateTypes.ts types + stateHandlers.ts reply/event maps, bridge.ts; App.tsx shell + tab routing; ChatView.tsx (chat view + history/plan/task/cost/question cards) → MessageItem.tsx (MessageItem/ApprovalCard) + Composer.tsx; SettingsView.tsx tab shell + per-tab TAB_VIEWS delegating to fields.tsx (Field/useForm/FieldRow/FIELD_CONTROLS/looksLikeKey), items.tsx (ItemCard/ItemsSection, optional `lead` slot), channelColors.tsx (`channelColor` id→palette-colour hash + `ChannelDot` badge; used by channel cards, role cards, wizard channel/review rows), channelExtra.tsx, agentExtra.tsx, rolesSection.tsx (agent-channel colour dot + small-font agent row), skillsSection.tsx, settingsEditor.tsx; SetupWizard.tsx keeps wizard state/effects and delegates steps to SetupWizardSteps.tsx (barrel over wizardStep0Welcome/1Channels/2Discover/3Evaluator.tsx, steps 0–3) + SetupWizardResult.tsx (steps 4–5), Busy.tsx (Spinner/BusyNote busy indicators), derived lists + wizard hooks (useWizardDerived/useWizardChannelForm/useWizardPreferences/useWizardProbes) via wizardDerived.ts, agent/role building via wizardApply.ts, shared constants/pure helpers (recommendArgs/rowRef) via wizardShared.ts)
  conformance/ golden v1 fixtures replayed through parsers
modules/       26 `@stewart/<module>` packages (MODULAR_DESIGN §9), each with a `README.md` (purpose, surface, owns, deps). Modules import only strictly lower layers (`scripts/layers.json`, `pnpm check:layers`); core imports modules by package name; every package is `composite` with a 90/80 coverage gate. Product version 2.1.2 (`hosts/vscode/package.json`, `build.gradle.kts`). Layers: see table in §1a.
hosts/
  vscode/      in-process core; host.ts implements HostPort via vscode API; routes.ts = webview message route table + dispatchAndReply (extension.ts activates, injects vscode api)
  jetbrains/   Kotlin: SidecarSupervisor (bundled Node, restart/backoff), HostRequestHandler, JCEF WebviewRouter
```

```
webview ─postMessage─ host ─(in-process | stdio NDJSON JSON-RPC)─ Core.dispatch
                                                                    │
                     ┌───────────────┬───────────────┬──────────────┼──────────────┐
                 ConfigStore     ChannelService    RunService    setup/probe    history, v1import
                 (YAML, schema)  (adapters)        ├ direct ─→ runRoleTask
                                                   ├ orchestrated ─→ OrchestratedRun ─→ roleRunner ─→ ToolLoop
                                                   └ resume ─→ roleRunner
```

### 1a. Module table

| Module | Layer | Purpose |
|---|---|---|
| `kernel` | 0 | Wire types, ports, EventBus and in-memory test fakes every other module builds on |
| `catalog` | 1 | Bundled model price/limits data and model-name normalization |
| `diagnostics` | 1 | Debug log: leveled sink, redaction, retention, RunEvent entries |
| `toolcall-format` | 1 | Shim tool-call text format: parser, prompt, live stream filter |
| `config` | 2 | YAML config files: schema, three-layer merge, store, SelfWriteGuard |
| `interaction` | 2 | The one owner of user-facing prompts: a FIFO queue showing one card at a time, with typed `Prompt<A>` and timeout/abort withdraw |
| `v1-import` | 2 | Legacy v1 stewart.xml importer: parses the v1 settings XML into v2 YAML config files (one-shot, deletable) |
| `models` | 2 | One merge of caps/probe/bench/catalog/price into a `ModelProfile` |
| `budget` | 3 | Budget profiles, loop limits, task-size classifier |
| `channels` | 3 | Provider adapters plus the managed policy wrapper and registry |
| `code-health` | 3 | Code-health report types, batching, aggregation, rendering |
| `ledger` | 3 | Append-only cost ledger and per-run cost cap |
| `permissions` | 3 | Approval categories, grants, tool previews, shell program splitter, approval gate |
| `roles-skills` | 3 | Role and skill definitions, validation, tool filter, prompt composition, effective config |
| `run-state` | 3 | Per-run durable state: idempotency log, pre-image snapshots/revert, chat history |
| `scheduling` | 3 | Task graph and path leases with deadlock detection |
| `compaction` | 4 | Context compaction as pure message transforms |
| `context` | 4 | Prompt context: @mentions, image attachment limits, project context files |
| `tools` | 5 | Tool registry, built-in tools by group, role guards, lease wrapper |
| `agent-loop` | 6 | The tool loop, the one session builder, fault classification |
| `run-contract` | 6 | The run contract shared by orchestration, recovery and runs: `RunRuntime`, `RoleTaskDeps`, `TaskResult`, `Recovery`, `RecoveryState` |
| `health-check` | 7 | Code-health run feature: submit_health / health_report verbs, per-run report state, preflight and required role tools, plugged into orchestrated runs via RunFeature |
| `orchestration` | 7 | Orchestrated runs: hub verbs, role task runner, replacement ranking |
| `recovery` | 7 | Fault recovery service implementing agent-loop's `Recovery`: layer-0 retry, continue question, layer-1 split |
| `setup` | 7 | Setup assistance: rules scorer, AI-refined assignment, model benchmark, setup quick-probe queue, workspace/hardware scan |
| `runs` | 8 | Run lifecycle: one pipeline, three strategies, approvals/asks, journal, revert, slash commands |

## 2. Core modules (`packages/core/src`)

| Area | Files | Role |
|---|---|---|
| Facade | `core.ts` (router, ~210 lines) + `handlers/{chat,config,setup,util,types}.ts` | `Core.dispatch` → `method → handler` table, one-liners into `handlers/*` (handlers see `Core` only through the `CoreCtx` interface in `handlers/types.ts`); owns per-project ctx, probe/price/ws caches, config apply, channel rebuild (via `channelService`), debug |
| Ports | `@stewart/kernel` `ports.ts` | `HostPort` (= `SecretsPort & FilesPort & ProcessPort & EditorPort & ProblemsPort & WorkspacePort & LogPort`; leaf code takes `Pick<HostPort, …>`), `Clock`, `IdGen`, `Fetcher` (injected; deterministic tests) |
| Events | `@stewart/kernel` `events.ts` | multi-subscriber `EventBus`, isolated async failures, delta coalescing |
| Config | `@stewart/config` (+ `effective.ts` in `roles-skills`) | YAML + zod schema, shipped < user < project merge by id, `SelfWriteGuard`; roles-skills adds skills + role validation (`loadEffectiveConfig`, `EffectiveConfig`; distinct from `@stewart/config` `Config`); `REQUIRED_ROLE_TOOLS` unions orchestration-critical tools into stale user roles.yaml snapshots (non-empty lists only); legacy XML import lives in `@stewart/v1-import` (own module, deletable; `config.importV1` handler only), via `importChannels`/`importAgents`/`importOllamaNumCtx`/`importVisionOverrides`/`importSettings` helpers |
| Channels | `@stewart/channels` (`registry,openai,ollama,stream,types`, `claude/*`) | `ChannelAdapter` per type; `ManagedChannel` adds `maxParallel`, breaker, stall timeout; `ChannelService` builds and looks up managed channels, reports health, applies secrets; `stream.ts` `StreamAccumulator`/`postForStream` shared by OpenAI and Ollama (provider-local wire decoders); Claude CLI uses `consumeStdout`/`toToolCalls`/`finishChat` instead of accumulator |
| Tools | `@stewart/agent-loop` + `@stewart/tools` (registry, built-ins incl. `ListCodeFiles` source inventory + `CodeMetrics` lexical scan, role guards) (+ `@stewart/toolcall-format`: shim parser/prompt/stream filter) | `ToolLoop` stages (stream → parse → execute), execution contract, shim, grants; `@stewart/compaction` = emergency context compaction (clip to note, else `context_limit`) + `pruneStale` (stub stale bulky tool results above 60% of the context cap; `settings.compaction.prune`, default off, wired for `roleRunner`/direct and orchestrator loops via `compactionFor`) + summarize stage (`summarizeMiddle`: pinned last user message \| middle → structured note from the enabled `compactor` role's agent \| last 6 messages, tool pairs intact; above 80% of the cap, `settings.compaction.summarize`, default off; no `compactor` role = inert; falls back to the clip on failure; metered to the ledger under role `compactor`; `compaction` event carries `beforeTokens/afterTokens/pruned/summarized`, shown as an activity line in the webview). The context cap `maxContextChars` is `contextCharsFor(model.contextTokens)` in `@stewart/budget` `limits.ts` (3 chars per window token, clamped 8k–400k chars; unknown window keeps 400k). Thresholds come from the budget profile (`compactionThresholds` in `@stewart/budget` `limits.ts`: quick 40/60%, normal 60/80%, deep 75/90% of the cap, `LoopLimits.pruneAt/summarizeAt`). Ingest cap: each tool result is cut to `maxToolOutputChars` (`toolOutputCap` in `@stewart/budget` `limits.ts`: ~10% of the context cap, max 20k, halved for quick, min 2k), keeping 70% head + 30% tail. Re-reads are deduped by `pruneStale` (superseded results stubbed). `toolcall-format/streamFilter.ts` (`ToolCallStreamFilter`, shim mode) hides tool-call blocks from live `text_delta`s; an unfinished block is held and shown at turn end only if nothing parsed. Shim parser also accepts `<tool_call name="X" arguments='{…}'>` and strips Gemma `<channel\|>`/`<\|channel>thought` markers; the orchestrator retries once with a format nudge when a zero-dispatch reply holds an unparsed tool-call tag. Gaps: not wired for recovery/bench (short loops) — see `../building/ARCHITECTURE_REFACTORING.md` R3 deviations) |
| Roles/skills | `@stewart/roles-skills` | role tool filter + `writePaths`, `roleTurnBudget`, copy-on-write skills, prompt composition; shipped `code-health` skill + `code-health-reviewer` role (disabled; wizard assigns; holds `CodeMetrics` for scoring evidence + `RunTerminal` for the project-checks task only) |
| Runs | `@stewart/runs` | `RunService`: run lifecycle via three strategies (direct/orchestrated/resume), `permissions.gate` approval gate, ledger, history, journal, revert |
| Interaction | `@stewart/interaction` | `Interaction`: FIFO prompt queue (approvals, ask_user, continue, plan gate, cost card, fallback, resume), timeout/abort withdraw, `pending()`; resolved from `chat.approve`/`chat.answer` |
| Orchestration | `@stewart/orchestration` + `@stewart/recovery` | `runOrchestrated`, `runRoleTask`, `createRecovery` (v1 port: classify, stuck check, continue question, layer-0 retry, layer-1 split, scratch; injected as `rt.recoveryService`), replacements; plugged-in features via `RunRuntime.features` (`RunFeature` in `@stewart/run-contract` `feature.ts`: per-run tools for the Orchestrator and dispatched tasks, terminal tool names, orchestrator default tools, required role tools, preflight; `runOrchestrated`/`runRoleTask`/`buildSession` read them, orchestration imports no feature; the app registers `RUN_FEATURES` in `packages/core/src/features.ts`, passed via `RunService` deps → `buildRunRuntime`, and `FEATURE_ROLE_TOOLS` into `loadEffectiveConfig` to union into stale roles.yaml). `@stewart/health-check` (L7) is the one feature today: verbs `submit_health` (terminal, report keyed by task id; optional `checks` = project test/coverage runs) + `health_report` (orchestrator-only merge/aggregate/render → `.stewart/scratch/health/<runId>.md`; adds a `Measured (lexical scan…)` line from `scanMetrics` over the merged file paths and a `Project checks:` section) |
| Setup | `@stewart/setup` (`assign`, `recommend`, `bench`, `probe`, `setupContext`, `session`) + `@stewart/catalog` | rules + AI assignment, benchmarks; `SetupSession` (§10): five-phase state machine, `setup-draft.json` under stateDir (versioned, 7-day expiry, resume), phase gates, coalesced `SetupEvent` progress, `review()`→ApprovalToken → `approveAndSave` (stale_approval → backup → validate → atomic writes → restore → delete draft), `undo`, secrets cleanup on cancel; protocol `setup.session.*`/`setup.review`/`setup.approve`/`setup.undo`, `setup.probe.start|status|cancel|retry` (per-project `SetupProbeRunner` quick-probe queue: provider-first order Ollama→Claude→evaluator-ranked rest, 30 s smoke deadline from admission → green/orange/red/skipped + `waitMs`/`attempts`/`lastReason`/`counts`, `runId` + channel/model/evaluator fingerprint — changed fingerprint or re-attach cancels and discards late results, abort-ignoring adapters drained 10 s then same-channel candidates skipped, reasons normalized + secret-redacted, retries bounded at 3, cancel = accept-and-continue, `recommend` consumes green via `eligible`), `setup.event` notification; wizard approve routes through it (channel adds still write `channels.yaml` directly — deviation), benchmarks (`ModelPerf`; tool/edit trials run through an injected `ProbeLoop` — contract in `models`, `createProbeLoop` in `agent-loop`, wired as `Core.probeLoop`; `setup` does not depend on `agent-loop`/`tools`), price catalog, workspace/hardware context; `assign.ts` `score` composed in dimension scorers `sizeScore`/`capabilityScore`/`contextScore`/`localityScore`/`perfScore`/`costScore`/`hardwareWarnings`, reason/warning order retained. Setup recommendation discovers channels, builds/ranks candidates, selects an evaluator, builds the prompt and validates assignments in private recommend.ts helpers; core handlers/setup.ts separates benchmark, preference persistence, context and probe/evaluator selection |
| Model facts | `@stewart/models` `profile.ts` | `resolveModelProfile`/`profileFromChannel`: caps, toolsMode, perf, price (agent > live > catalog), cost tier, `contextTokens` (`numCtx` > `contextTokens` > catalog); `mergeProbeCaps` (user > probe); used by `@stewart/budget` `limits.ts`, `roles.ts`, `recommend.ts` (caps), `core.ts` |
| Agent session | `@stewart/agent-loop` `session.ts` | `createAgentSession`: the one `ToolLoop` builder (profile → limits → listener with events + ledger metering). Used by `roleRunner`, orchestrator, recovery and `createProbeLoop` (bench); the only `new ToolLoop(` |
## 3. Run paths (current reality)

Phase 2 keeps the run contracts intact: role task agent/fallback resolution, session wiring and TaskResult mapping live in roleRunner helpers; recover.ts dispatches layer-0 retry, continue question and split via helpers with the existing counters; resume.ts separates journal loading, planning and per-task replay; ToolLoop separates turn preparation, stream-outcome decisions and parsed/tool execution.

| Path | Entry | Ledger/cost cap | Leases | Idempotency | Journal/resume | `maxRunHours` | Turn budget | Recovery |
|---|---|---|---|---|---|---|---|---|
| Direct | `RunService.direct` → `directStrategy` → `runRoleTask` (single task `direct`, chat role or synthetic `chat`) | yes | yes (`taskId "direct"`) | yes | yes (`run.json` with one `direct` task + `agentId`; `/resume` replays the original request only — no chat history — on the journaled agent, executed calls skipped via the idempotency log) | `rt.timeCap` | `resolveLimits` | continue question (in `direct` strategy) |
| Orchestrated | `RunService.orchestrated` → `orchestratedStrategy` → `runOrchestrated` | yes | yes | yes | yes | runtime `timeCap` timer (`buildRunRuntime`) → `interrupted`/`stopped` | `resolveLimits` | layer 0/1 via `rt.recoveryService.runTask` |
| Resume | `RunService.resume` → `resumeStrategy` → `rt.recoveryService.runTask` | yes | yes | yes | yes | runtime `timeCap` timer (`buildRunRuntime`) → `interrupted`/`stopped` | `resolveLimits` | layer 0/1 |

- Health check (`@stewart/health-check` feature): its `preflight` uses `isHealthCheckRequest(userText)` and requires an enabled `code-health-reviewer` (missing → run fails with an enable-it message); the `orchestrate` skill routes the Orchestrator to `ListCodeFiles` → batched `code-health-reviewer` dispatches (each ends in `submit_health`) plus one 'Project checks' task (reviewer detects the project's test/coverage command, runs it once via `RunTerminal`, submits `checks`) → `health_report`, which merges reports + checks, scans each merged file path with `scanMetrics` for the `Measured (lexical scan…)` line, writes `.stewart/scratch/health/<runId>.md` and returns the rendered text.

Webview: a lone `direct` task shows no Active/Tasks rows; the direct strategy emits `cost.summary` before `run.finished` when the run accrued cost (free agents emit none), so the Cost card shows for direct runs.

Limits: `@stewart/budget` `limits.ts` `resolveLimits` (budget profile quick/normal/deep × model speed/cost/reliability factors, `maxWorkerTurnsCeiling`), called only from `createAgentSession`.

`ToolLoop` is built only in `createAgentSession` (R1 done); call sites supply registry/approve/prompt and opt into `meter`/`events`. The run runtime (`RunRuntime`, in `@stewart/run-contract` `runtime.ts`) is built once, in `buildRunRuntime` (`@stewart/runs` `runtime.ts`; invoked inside `runPipeline` for all three strategies), owns the run time cap as one abort timer (`rt.timeCap`, cancelled in `finally`), and carries `rt.recoveryService` (`createRecovery(runRoleTask)` from `@stewart/recovery`, held on `RunService`). Direct runs are a single-task run of the same pipeline (`runRoleTask` with `agent`/`prompt`/`history` overrides); cost is metered and capped, transcript kept on every outcome. Orchestrated chat also loads the `ChatHistoryStore` session (`handleChatSend` → `OrchestratedRequest.history`): `orchestratedStrategy.plan` seeds `run.messages` with prior `user` messages and tool-call-free `assistant` replies plus the current text, `runOrchestrated`/`runSession` send that prefix to the model (retry inputs rebuild from the same `host.history`), and `finalize` returns the last assistant reply as `OrchestrationOutcome.reply`, which the strategy appends to `run.messages` so `saveHistory` persists it (including `no_dispatch` clarification answers). `loadProjectContext` (`@stewart/context`, shared by orchestrator/role/direct/resume prompts) now prepends a `# Workspace` section from `host.workspace.roots()` naming the real project root and warning that the Claude CLI's isolated `/tmp/stewart-claude-*` cwd is not it (or stating the root is unavailable when the host reports none).

## 4. Model facts

Per `channel/model`, facts come from: `modelCaps` in `channels.yaml` (user, wins) ← probe cache (in-memory, `applyProbes`) ← bench `perf` ← catalog (`catalog.data.json`) / live `priceList`; agent `price` wins for cost. `models/profile.ts` is the single merge for `roles.ts` and `@stewart/budget` `limits.ts`; Raw `modelCaps` reads go through `@stewart/models` `userCaps` (user fields as written, absent = unknown) or `capsFor` (under `DEFAULT_CAPS`); `check:boundaries` forbids raw `modelCaps?.[…]` reads outside `models`, `config`, `v1-import`, core's probe-merge write and the webview (`forbidden` rules in `scripts/boundaries.json`). `recommend.ts` price (agent > `priceFor`, no catalog) is separate.

## 5. Config and state

- Files: shared `~/.config/stewart/{channels,agents,roles,settings}.yaml`, `skills/` — one dir for every IDE and project (`@stewart/config` `userDir.ts` `sharedUserConfigDir`: `$STEWART_CONFIG_DIR` > `$XDG_CONFIG_HOME/stewart` > `%APPDATA%\stewart` > `~/.config/stewart`; Kotlin mirror `UserConfigDir.kt`). Created on host start (`ensureUserConfigDir`), which also copies missing files once from the legacy per-project JetBrains `user-config/<hash>` and VS Code `globalStorage/user-config` dirs (never overwrites). Files must be `.yaml` (not `.yml`); project `.stewart/{roles.yaml,skills/,scratch/}` (trusted workspaces only).
- State dir (HostPort): `ledger.jsonl`, run journals, `scratch/<runId>/{executed.jsonl,snapshots/}`, history.
- `files.*` path contract (both hosts): absolute paths used as-is (state dir, config); relative paths resolve under the workspace root. `files.list` returns `dir`-prefixed relative paths (`""`/`"."` → unprefixed).
- Secrets via HostPort only (`secretRef`).

## 6. In progress

- Budgets M5 done (`6d4ea05`: `@stewart/budget` `taskSize.ts` classifier, `/quick` `/deep`); fault-recovery machinery ported (unblocks M6 escalation).
- Code-health project check built (`docs/building/PROJECT_HEALTH_CHECK.md`): `code-health` module + generic `metrics.ts` lexical scanner, `CodeMetrics` tool, `submit_health`/`health_report` + `checks` project checks, orchestrate-skill routing; manual smoke pending.
- Complexity report: `node scripts/complexity-scan.mjs` scans TS/TSX in modules/packages/hosts; it is non-blocking and uses different branch-count methodology from the code-health report. Phases 1–3 are done (`tasks/complexity-refactor-plan.md`); Phase-3 targets/helpers are below 15 branches, but 22 untouched functions still exceed 15 repository-wide.

## 7. Known gaps vs v2 plan

- No v1 layer-2 fault note on re-plans, no `num_ctx` auto-detect; budget escalation (M6) still unbuilt (`../archived_v2/BUDGETS_AND_SETUP_INFO.md` B4).
- Probe cache not persisted across restarts (bench `perf` persisted via `modelCaps`).

# Stewart — Architecture Now

Living description of the code **as it is**. Update in the same commit as any change to modules, run paths, protocol, config, or host wiring. Plans live elsewhere (`docs/archived_v2/ARCHITECTURE.md` = original v2 plan; `docs/BUDGETS_AND_SETUP_INFO.md`, `docs/2026-11-07-code-health.md` = current plans).

Last updated: 2026-11-07 (modular migration M-7: `runs` + `setup` extracted, `core.ts` is a router). Planned restructuring: `docs/ARCHITECTURE_REFACTORING.md`.

## 1. Layout

```
packages/
  protocol/    JSON-RPC types, PROTOCOL_VERSION, capability negotiation (src/index.ts)
  core/        all logic; no host imports
  sidecar/     Node stdio JSON-RPC server for JetBrains (rpc.ts, server.ts, host.ts reverse-RPC → HostPort, debugSink.ts)
  webview/     Preact chat + settings + setup wizard, one bundle for both hosts (state.ts store, bridge.ts)
  conformance/ golden v1 fixtures replayed through parsers
modules/       22 `@stewart/<module>` packages (MODULAR_DESIGN §9), filled in as code migrates from core (§7). Extracted so far: `kernel` (wire types `Json/ToolCall/ChatMessage/ToolSpec/IdempotencyHooks`, `stripImages`, `mediaTypeFor`; `ports.ts`: `HostPort`, `Clock`, `IdGen`, `Fetcher`, `systemClock`, `nodeFetch`; `testing.ts`: `fakeHost`, `fakeFetcher`, `collect` for every package's tests; core's index re-exports the ports), `toolcall-format` (`shimParser`, `shimPrompt`, `streamFilter`), `compaction` (`compaction.ts`: measure/clip/prune/summarize transforms), `scheduling` (`TaskGraph`, `LeaseManager`), `catalog` (`catalog.ts` + `catalog.data.json`, `normalizeModel`, bundled by tsc into the module's dist), `permissions` (`grants.ts`: `Grants`; `shell.ts`: `splitShellPrograms`; `preview.ts`: `ToolPreview`, `ApprovalCategory`, `categoryOf`), `agent-loop` (`toolLoop.ts` `ToolLoop`, `loopTypes.ts`, `session.ts` `createAgentSession` (events via an `{emit}` sink), `faults.ts`, `runtime.ts`: `OrchestrationRuntime`/`RunRuntime` alias, `RoleTaskDeps`, `TaskResult`, `RecoveryState`/`recoveryState`, `Recovery` interface), `run-state` (`idempotency.ts`, `history.ts`, `snapshots.ts`: lease errors, `recordPreImage`, `revertRunSnapshots`; the lease-wrapping `leasedTools` is in `tools/leaseGuard.ts`), `roles-skills` (`roles.ts`: globs, role capability/validation, turn budget; `skills.ts`, `defaults/*`), `tools` (`types.ts` Tool/ToolRegistry/outcomes, `projectPaths.ts`, built-ins split into `fsRead/fsWrite/process/media.ts` + `toolBase.ts`, `roleRegistry.ts` guards), `channels` (adapters + `ManagedChannel` + `ChannelRegistry`; `stripImages` lives in kernel `wire.ts`), `config` (`schema`, `loader` = merge by id without skills/role validation, `store`, `files`, `userDir`; `roles-skills/effective.ts` adds `skills` + `validateRoles`), `diagnostics` (`debug.ts`: `DebugLogger`, redaction, `eventEntry`), `context` (`images.ts`, `mentions.ts`, `projectContext.ts`), `ledger` (`RunLedger`, `CostLimit`, `costOfCall`; replacement ranking lives in `@stewart/orchestration` `replacements.ts`), `models` (`caps.ts`: `ModelCaps/ModelPerf/ToolsMode/DEFAULT_CAPS/isCosting`; `profile.ts`: `ModelProfile`, `profileFromChannel`), `budget` (`@stewart/budget` `limits.ts`: profiles, `LoopLimits/DEFAULT_LIMITS`, `resolveLimits({baseTurns,…})`; `@stewart/budget` `taskSize.ts`), `orchestration` (`orchestrator.ts` `runOrchestrated`, `roleRunner.ts` `runRoleTask`, `replacements.ts`, `tools.ts` `orchestrationTools`), `recovery` (`service.ts` `createRecovery(runRoleTask)` injected as `rt.recoveryService`, plus `brain/recover/split/plan/continue/scratch/consts`), `setup` (`assign.ts` rules scorer, `recommend.ts`, `bench.ts` `ModelPerf` probes, `setupContext.ts` workspace/hardware scan), `runs` (`service.ts` `RunService`: run state, grants + approval gate, ledger/history, journal, revert; `direct.ts`/`orchestrated.ts`/`resume.ts` = the three `RunStrategy` objects on one pipeline, typed against the `RunHost` interface in `types.ts`; `runtime.ts` `buildRunRuntime`; `parseCommand.ts` `/direct` `/quick` `/deep` parsing), `interaction` (`Interaction`: the one owner of user-facing prompt cards — `approval`, `ask`, `askTimed` with abort/timeout → `question.withdrawn`; `resolveApproval`/`resolveAnswer` called from `chat.approve`/`chat.answer`; `RunService.gate/askUser/askTimed` delegate to it); `kernel` also gained `events.ts` (`EventBus` delta coalescing); tests live in the modules. All 22 modules now hold code. Every package is `composite` with tsconfig `references` (`scripts/sync-tsrefs.mjs`) and a per-package coverage gate (`test:coverage`, 90/80, all packages passing; module tests live in their module, `packages/core/test` keeps only `Core`-dispatch tests); CI also runs `check:cycles` (dependency-cruiser). Product version 2.1.0 (`hosts/vscode/package.json`, `build.gradle.kts`). Modules import only `@stewart/<lower layer>`; core imports modules via their package name. Code migrates in from core per §7; `pnpm check:layers` enforces layer table `scripts/layers.json`; `scripts/new-module.mjs` adds one; `pnpm check:boundaries` ratchets cross-layer imports/oversize files still inside core (baseline `scripts/boundaries.baseline.json`)
hosts/
  vscode/      in-process core; host.ts implements HostPort via vscode API
  jetbrains/   Kotlin: SidecarSupervisor (bundled Node, restart/backoff), HostRequestHandler, JCEF WebviewRouter
```

```
webview ─postMessage─ host ─(in-process | stdio NDJSON JSON-RPC)─ Core.dispatch
                                                                    │
                     ┌───────────────┬───────────────┬──────────────┼──────────────┐
                 ConfigStore     ChannelRegistry   RunService    setup/probe    history, v1import
                 (YAML, schema)  (adapters)        ├ direct ─→ driveDirect ─→ runRoleTask
                                                   ├ orchestrated ─→ OrchestratedRun ─→ roleRunner ─→ ToolLoop
                                                   └ resume ─→ roleRunner
```

## 2. Core modules (`packages/core/src`)

| Area | Files | Role |
|---|---|---|
| Facade | `core.ts` (router, ~210 lines) + `handlers/{chat,config,setup,util,types}.ts` | `Core.dispatch` → `method → handler` table, one-liners into `handlers/*` (handlers see `Core` only through the `CoreCtx` interface in `handlers/types.ts`); owns per-project ctx, probe/price/ws caches, config apply, channel rebuild, debug |
| Ports | `@stewart/kernel` `ports.ts` | `HostPort` (= `SecretsPort & FilesPort & ProcessPort & EditorPort & ProblemsPort & WorkspacePort & LogPort`; leaf code takes `Pick<HostPort, …>`), `Clock`, `IdGen`, `Fetcher` (injected; deterministic tests) |
| Events | `@stewart/kernel` `events.ts` | multi-subscriber `EventBus`, isolated async failures, delta coalescing |
| Config | `@stewart/config` (+ `effective.ts` in `roles-skills`) | YAML + zod schema, shipped < user < project merge by id, `SelfWriteGuard`; roles-skills adds skills + role validation (`loadConfig`, `Config`) |
| Channels | `@stewart/channels` (`registry,openai,ollama,stream,types`, `claude/*`) | `ChannelAdapter` per type; `ManagedChannel` adds `maxParallel`, breaker, stall timeout |
| Tools | `@stewart/agent-loop` + `@stewart/tools` (registry, built-ins, role guards) (+ `@stewart/toolcall-format`: shim parser/prompt/stream filter) | `ToolLoop` stages (stream → parse → execute), execution contract, shim, grants; `@stewart/compaction` = emergency context compaction (clip to note, else `context_limit`) + `pruneStale` (stub stale bulky tool results above 60% of the context cap; `settings.compaction.prune`, default off, wired for `roleRunner`/direct and orchestrator loops via `compactionFor`) + summarize stage (`summarizeMiddle`: pinned last user message | middle → structured note from the enabled `compactor` role's agent | last 6 messages, tool pairs intact; above 80% of the cap, `settings.compaction.summarize`, default off; no `compactor` role = inert; falls back to the clip on failure; metered to the ledger under role `compactor`; `compaction` event carries `beforeTokens/afterTokens/pruned/summarized`, shown as an activity line in the webview). The context cap `maxContextChars` is `contextCharsFor(model.contextTokens)` in `@stewart/budget` `limits.ts` (3 chars per window token, clamped 8k–400k chars; unknown window keeps 400k). Thresholds come from the budget profile (`compactionThresholds` in `@stewart/budget` `limits.ts`: quick 40/60%, normal 60/80%, deep 75/90% of the cap, `LoopLimits.pruneAt/summarizeAt`). Ingest cap: each tool result is cut to `maxToolOutputChars` (`toolOutputCap` in `@stewart/budget` `limits.ts`: ~10% of the context cap, max 20k, halved for quick, min 2k), keeping 70% head + 30% tail. Re-reads are deduped by `pruneStale` (superseded results stubbed). `toolcall-format/streamFilter.ts` (`ToolCallStreamFilter`, shim mode) hides tool-call blocks from live `text_delta`s; an unfinished block is held and shown at turn end only if nothing parsed. Shim parser also accepts `<tool_call name="X" arguments='{…}'>` and strips Gemma `<channel|>`/`<|channel>thought` markers; the orchestrator retries once with a format nudge when a zero-dispatch reply holds an unparsed tool-call tag. Gaps: not wired for recovery/bench (short loops) — see `ARCHITECTURE_REFACTORING.md` R3 deviations) |
| Roles/skills | `@stewart/roles-skills` | role tool filter + `writePaths`, `roleTurnBudget`, copy-on-write skills, prompt composition; shipped `code-health` skill + read-only `code-health-reviewer` role (disabled) |
| Runs | `@stewart/runs` | `RunService`: run lifecycle via three strategies (direct/orchestrated/resume), grants + approval gate, ledger, history, journal, revert |
| Interaction | `@stewart/interaction` | `Interaction`: approval + `ask_user` cards, timeout/abort withdraw; resolved from `chat.approve`/`chat.answer` |
| Orchestration | `@stewart/orchestration` + `@stewart/recovery` | `runOrchestrated`, `runRoleTask`, `createRecovery` (v1 port: classify, stuck check, continue question, layer-0 retry, layer-1 split, scratch; injected as `rt.recoveryService`), replacements |
| Setup | `@stewart/setup` (`assign`, `recommend`, `bench`, `setupContext`) + `@stewart/catalog` | rules + AI assignment, benchmarks (`ModelPerf`), price catalog, workspace/hardware context |
| Model facts | `@stewart/models` `profile.ts` | `resolveModelProfile`/`profileFromChannel`: caps, toolsMode, perf, price (agent > live > catalog), cost tier, `contextTokens` (`numCtx` > `contextTokens` > catalog); `mergeProbeCaps` (user > probe); used by `@stewart/budget` `limits.ts`, `roles.ts`, `recommend.ts` (caps), `core.ts` |
| Agent session | `@stewart/agent-loop` `session.ts` | `createAgentSession`: the one `ToolLoop` builder (profile → limits → listener with events + ledger metering). Used by `roleRunner`, orchestrator, recovery and bench; the only `new ToolLoop(` |
| Misc | `v1import.ts` | |

## 3. Run paths (current reality)

| Path | Entry | Ledger/cost cap | Leases | Idempotency | Journal/resume | `maxRunHours` | Turn budget | Recovery |
|---|---|---|---|---|---|---|---|---|
| Direct | `RunService.direct` → `directStrategy` → `runRoleTask` (single task `direct`, chat role or synthetic `chat`) | yes | yes (`taskId "direct"`) | yes | yes (`run.json` with one `direct` task + `agentId`; `/resume` replays the original request only — no chat history — on the journaled agent, executed calls skipped via the idempotency log) | `rt.timeCap` | `resolveLimits` | continue question (in `direct` strategy) |
| Orchestrated | `RunService.orchestrated` → `orchestratedStrategy` → `runOrchestrated` | yes | yes | yes | yes | runtime `timeCap` timer (`buildRunRuntime`) → `interrupted`/`stopped` | `resolveLimits` | layer 0/1 via `rt.recoveryService.runTask` |
| Resume | `RunService.resume` → `resumeStrategy` → `rt.recoveryService.runTask` | yes | yes | yes | yes | runtime `timeCap` timer (`buildRunRuntime`) → `interrupted`/`stopped` | `resolveLimits` | layer 0/1 |

Webview: a lone `direct` task shows no Active/Tasks rows; `driveDirect` emits `cost.summary` before `run.finished` when the run accrued cost (free agents emit none), so the Cost card shows for direct runs.

Limits: `@stewart/budget` `limits.ts` `resolveLimits` (budget profile quick/normal/deep × model speed/cost/reliability factors, `maxWorkerTurnsCeiling`), called only from `createAgentSession`.

`ToolLoop` is built only in `createAgentSession` (R1 done); call sites supply registry/approve/prompt and opt into `meter`/`events`. The orchestration runtime (`RunRuntime`, alias `OrchestrationRuntime`, in `@stewart/agent-loop` `runtime.ts`) is built once, in `buildRunRuntime` (`@stewart/runs` `runtime.ts`; used by all three strategies), owns the run time cap as one abort timer (`rt.timeCap`, cancelled in `finally`), and carries `rt.recoveryService` (`createRecovery(runRoleTask)` from `@stewart/recovery`, held on `RunService`). Direct runs are a single-task run of the same pipeline (`runRoleTask` with `agent`/`prompt`/`history` overrides); cost is metered and capped, transcript kept on every outcome.

## 4. Model facts

Per `channel/model`, facts come from: `modelCaps` in `channels.yaml` (user, wins) ← probe cache (in-memory, `applyProbes`) ← bench `perf` ← catalog (`catalog.data.json`) / live `priceList`; agent `price` wins for cost. `models/profile.ts` is the single merge for `roles.ts` and `@stewart/budget` `limits.ts`; Remaining direct `modelCaps` reads: `channels/registry.ts` (vision), `channels/ollama.ts` (`numCtx`), `@stewart/orchestration` `replacements.ts` (contextTokens), `roleRunner` (imageGen), `bench.ts` (tools mode); `recommend.ts` price (agent > `priceFor`, no catalog) is separate.

## 5. Config and state

- Files: shared `~/.config/stewart/{channels,agents,roles,settings}.yaml`, `skills/` — one dir for every IDE and project (`@stewart/config` `userDir.ts` `sharedUserConfigDir`: `$STEWART_CONFIG_DIR` > `$XDG_CONFIG_HOME/stewart` > `%APPDATA%\stewart` > `~/.config/stewart`; Kotlin mirror `UserConfigDir.kt`). Created on host start (`ensureUserConfigDir`), which also copies missing files once from the legacy per-project JetBrains `user-config/<hash>` and VS Code `globalStorage/user-config` dirs (never overwrites). Files must be `.yaml` (not `.yml`); project `.stewart/{roles.yaml,skills/,scratch/}` (trusted workspaces only).
- State dir (HostPort): `ledger.jsonl`, run journals, `scratch/<runId>/{executed.jsonl,snapshots/}`, history.
- Secrets via HostPort only (`secretRef`).

## 6. In progress

- Budgets M5 done (`6d4ea05`: `@stewart/budget` `taskSize.ts` classifier, `/quick` `/deep`); fault-recovery machinery ported (unblocks M6 escalation).
- Code-health skill + `code-health-reviewer` role — planned (`docs/2026-11-07-code-health.md`).

## 7. Known gaps vs v2 plan

- No v1 layer-2 fault note on re-plans, no `num_ctx` auto-detect; budget escalation (M6) still unbuilt (`BUDGETS_AND_SETUP_INFO.md` B4).
- Probe cache not persisted across restarts (bench `perf` persisted via `modelCaps`).

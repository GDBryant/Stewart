# Stewart — Architecture Now

Living description of the code **as it is**. Update in the same commit as any change to modules, run paths, protocol, config, or host wiring. Plans live elsewhere (`docs/archived_v2/ARCHITECTURE.md` = original v2 plan; `docs/BUDGETS_AND_SETUP_INFO.md`, `docs/2026-11-07-code-health.md` = current plans).

Last updated: 2026-11-07 (after `57e3da9`, budgets M4). Planned restructuring: `docs/ARCHITECTURE_REFACTORING.md`.

## 1. Layout

```
packages/
  protocol/    JSON-RPC types, PROTOCOL_VERSION, capability negotiation (src/index.ts)
  core/        all logic; no host imports
  sidecar/     Node stdio JSON-RPC server for JetBrains (rpc.ts, server.ts, host.ts reverse-RPC → HostPort, debugSink.ts)
  webview/     Preact chat + settings + setup wizard, one bundle for both hosts (state.ts store, bridge.ts)
  conformance/ golden v1 fixtures replayed through parsers
modules/       22 `@stewart/<module>` packages (MODULAR_DESIGN §9), filled in as code migrates from core (§7). Extracted so far: `kernel` (wire types `Json/ToolCall/ChatMessage/ToolSpec`), `toolcall-format` (`shimParser`, `shimPrompt`, `streamFilter`; tests live in the module). Others are empty (`src/api.ts` only). Modules import only `@stewart/<lower layer>`; core imports modules via their package name. Code migrates in from core per §7; `pnpm check:layers` enforces layer table `scripts/layers.json`; `scripts/new-module.mjs` adds one; `pnpm check:boundaries` ratchets cross-layer imports/oversize files still inside core (baseline `scripts/boundaries.baseline.json`)
hosts/
  vscode/      in-process core; host.ts implements HostPort via vscode API
  jetbrains/   Kotlin: SidecarSupervisor (bundled Node, restart/backoff), HostRequestHandler, JCEF WebviewRouter
```

```
webview ─postMessage─ host ─(in-process | stdio NDJSON JSON-RPC)─ Core.dispatch
                                                                    │
                     ┌───────────────┬───────────────┬──────────────┼──────────────┐
                 ConfigStore     ChannelRegistry   RunManager    setup/probe    history, v1import
                 (YAML, schema)  (adapters)        ├ direct ─→ driveDirect ─→ runRoleTask
                                                   ├ orchestrated ─→ OrchestratedRun ─→ roleRunner ─→ ToolLoop
                                                   └ resume ─→ roleRunner
```

## 2. Core modules (`packages/core/src`)

| Area | Files | Role |
|---|---|---|
| Facade | `core.ts` (~600 lines) | `Core.dispatch` → `handleXxx` per JSON-RPC method; owns per-project ctx, probe cache, config apply, debug |
| Ports | `ports.ts` | `HostPort`, `Clock`, `IdGen`, `Fetcher` (injected; deterministic tests) |
| Events | `events.ts` | multi-subscriber `EventBus`, isolated async failures |
| Config | `config/{schema,loader,files,store}.ts` | YAML + zod schema, shipped < user < project merge by id, `SelfWriteGuard` |
| Channels | `channels/{registry,openai,ollama,stream,types}.ts`, `channels/claude/*` | `ChannelAdapter` per type; `ManagedChannel` adds `maxParallel`, breaker, stall timeout |
| Tools | `tools/{toolLoop,compaction,builtins,approvals,projectPaths,types}.ts` (+ `@stewart/toolcall-format`: shim parser/prompt/stream filter) | `ToolLoop` stages (stream → parse → execute), execution contract, shim, grants; `compaction.ts` = emergency context compaction (clip to note, else `context_limit`) + `pruneStale` (stub stale bulky tool results above 60% of the context cap; `settings.compaction.prune`, default off, wired for `roleRunner`/direct and orchestrator loops via `compactionFor`) + summarize stage (`summarizeMiddle`: pinned last user message | middle → structured note from the enabled `compactor` role's agent | last 6 messages, tool pairs intact; above 80% of the cap, `settings.compaction.summarize`, default off; no `compactor` role = inert; falls back to the clip on failure; metered to the ledger under role `compactor`; `compaction` event carries `beforeTokens/afterTokens/pruned/summarized`, shown as an activity line in the webview). The context cap `maxContextChars` is `contextCharsFor(model.contextTokens)` in `limits.ts` (3 chars per window token, clamped 8k–400k chars; unknown window keeps 400k). Thresholds come from the budget profile (`compactionThresholds` in `limits.ts`: quick 40/60%, normal 60/80%, deep 75/90% of the cap, `LoopLimits.pruneAt/summarizeAt`). Ingest cap: each tool result is cut to `maxToolOutputChars` (`toolOutputCap` in `limits.ts`: ~10% of the context cap, max 20k, halved for quick, min 2k), keeping 70% head + 30% tail. Re-reads are deduped by `pruneStale` (superseded results stubbed). `toolcall-format/streamFilter.ts` (`ToolCallStreamFilter`, shim mode) hides tool-call blocks from live `text_delta`s; an unfinished block is held and shown at turn end only if nothing parsed. Shim parser also accepts `<tool_call name="X" arguments='{…}'>` and strips Gemma `<channel|>`/`<|channel>thought` markers; the orchestrator retries once with a format nudge when a zero-dispatch reply holds an unparsed tool-call tag. Gaps: not wired for recovery/bench (short loops) — see `ARCHITECTURE_REFACTORING.md` R3 deviations) |
| Roles/skills | `roles.ts`, `skills/skills.ts`, `defaults/*` | role tool filter + `writePaths`, `roleTurnBudget`, copy-on-write skills, prompt composition; shipped `code-health` skill + read-only `code-health-reviewer` role (disabled) |
| Runs | `runManager.ts` | run lifecycle, approvals/answers, ledger, history, journal, revert, resume |
| Orchestration | `orchestration/*` | `OrchestratedRun`, `roleRunner`, `recovery`/`faults` (v1 port: classify, stuck check, continue question, layer-0 retry, layer-1 split, scratch), `TaskGraph`, `LeaseManager`, `RunLedger`/`CostLimit`, `IdempotencyLog`, `writeGuard` snapshots, replacements |
| Setup | `assign.ts`, `recommend.ts`, `bench.ts`, `catalog.ts`(+`.data.json`), `setupContext.ts` | rules + AI assignment, benchmarks (`ModelPerf`), price catalog, workspace/hardware context |
| Model facts | `modelProfile.ts` | `resolveModelProfile`/`profileFromChannel`: caps, toolsMode, perf, price (agent > live > catalog), cost tier, `contextTokens` (`numCtx` > `contextTokens` > catalog); `mergeProbeCaps` (user > probe); used by `limits.ts`, `roles.ts`, `recommend.ts` (caps), `core.ts` |
| Agent session | `agentSession.ts` | `createAgentSession`: the one `ToolLoop` builder (profile → limits → listener with events + ledger metering). Used by `roleRunner`, orchestrator, recovery and bench; the only `new ToolLoop(` |
| Misc | `history.ts`, `images.ts`, `mentions.ts`, `projectContext.ts`, `v1import.ts`, `debug/debug.ts` | |

## 3. Run paths (current reality)

| Path | Entry | Ledger/cost cap | Leases | Idempotency | Journal/resume | `maxRunHours` | Turn budget | Recovery |
|---|---|---|---|---|---|---|---|---|
| Direct | `RunManager.direct` → `driveDirect` → `runRoleTask` (single task `direct`, chat role or synthetic `chat`) | yes | yes (`taskId "direct"`) | yes | yes (`run.json` with one `direct` task + `agentId`; `/resume` replays the original request only — no chat history — on the journaled agent, executed calls skipped via the idempotency log) | `rt.timeCap` | `resolveLimits` | continue question (in `driveDirect`) |
| Orchestrated | `RunManager.orchestrated` → `runOrchestrated` | yes | yes | yes | yes | runtime `timeCap` timer (`buildRuntime`) → `interrupted`/`stopped` | `resolveLimits` | layer 0/1 via `runTaskRecoverable` |
| Resume | `RunManager.resume` → `runTaskRecoverable` | yes | yes | yes | yes | runtime `timeCap` timer (`buildRuntime`) → `interrupted`/`stopped` | `resolveLimits` | layer 0/1 |

Webview: a lone `direct` task shows no Active/Tasks rows; `driveDirect` emits `cost.summary` before `run.finished` when the run accrued cost (free agents emit none), so the Cost card shows for direct runs.

Limits: `limits.ts` `resolveLimits` (budget profile quick/normal/deep × model speed/cost/reliability factors, `maxWorkerTurnsCeiling`), called only from `createAgentSession`.

`ToolLoop` is built only in `createAgentSession` (R1 done); call sites supply registry/approve/prompt and opt into `meter`/`events`. The orchestration runtime (`RunRuntime`, alias `OrchestrationRuntime`) is built once, in `RunManager.buildRuntime` (used by `resume`, `driveOrchestrated`, `driveDirect`) and owns the run time cap as one abort timer (`rt.timeCap`, cancelled in `finally`). Direct runs are a single-task run of the same pipeline (`runRoleTask` with `agent`/`prompt`/`history` overrides); cost is metered and capped, transcript kept on every outcome.

## 4. Model facts

Per `channel/model`, facts come from: `modelCaps` in `channels.yaml` (user, wins) ← probe cache (in-memory, `applyProbes`) ← bench `perf` ← catalog (`catalog.data.json`) / live `priceList`; agent `price` wins for cost. `modelProfile.ts` is the single merge for `roles.ts` and `limits.ts`; Remaining direct `modelCaps` reads: `channels/registry.ts` (vision), `channels/ollama.ts` (`numCtx`), `orchestration/replacements.ts` (contextTokens), `roleRunner` (imageGen), `bench.ts` (tools mode); `recommend.ts` price (agent > `priceFor`, no catalog) is separate.

## 5. Config and state

- Files: shared `~/.config/stewart/{channels,agents,roles,settings}.yaml`, `skills/` — one dir for every IDE and project (`config/userDir.ts` `sharedUserConfigDir`: `$STEWART_CONFIG_DIR` > `$XDG_CONFIG_HOME/stewart` > `%APPDATA%\stewart` > `~/.config/stewart`; Kotlin mirror `UserConfigDir.kt`). Created on host start (`ensureUserConfigDir`), which also copies missing files once from the legacy per-project JetBrains `user-config/<hash>` and VS Code `globalStorage/user-config` dirs (never overwrites). Files must be `.yaml` (not `.yml`); project `.stewart/{roles.yaml,skills/,scratch/}` (trusted workspaces only).
- State dir (HostPort): `ledger.jsonl`, run journals, `scratch/<runId>/{executed.jsonl,snapshots/}`, history.
- Secrets via HostPort only (`secretRef`).

## 6. In progress

- Budgets M5 done (`6d4ea05`: `taskSize.ts` classifier, `/quick` `/deep`); fault-recovery machinery ported (unblocks M6 escalation).
- Code-health skill + `code-health-reviewer` role — planned (`docs/2026-11-07-code-health.md`).

## 7. Known gaps vs v2 plan

- No v1 layer-2 fault note on re-plans, no `num_ctx` auto-detect; budget escalation (M6) still unbuilt (`BUDGETS_AND_SETUP_INFO.md` B4).
- Probe cache not persisted across restarts (bench `perf` persisted via `modelCaps`).

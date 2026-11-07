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
hosts/
  vscode/      in-process core; host.ts implements HostPort via vscode API
  jetbrains/   Kotlin: SidecarSupervisor (bundled Node, restart/backoff), HostRequestHandler, JCEF WebviewRouter
```

```
webview ─postMessage─ host ─(in-process | stdio NDJSON JSON-RPC)─ Core.dispatch
                                                                    │
                     ┌───────────────┬───────────────┬──────────────┼──────────────┐
                 ConfigStore     ChannelRegistry   RunManager    setup/probe    history, v1import
                 (YAML, schema)  (adapters)        ├ direct ─→ drive() ─→ ToolLoop
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
| Tools | `tools/{toolLoop,builtins,shimParser,shimPrompt,approvals,projectPaths,types}.ts` | `ToolLoop` stages (stream → parse → execute), execution contract, shim, grants |
| Roles/skills | `roles.ts`, `skills/skills.ts`, `defaults/*` | role tool filter + `writePaths`, `roleTurnBudget`, copy-on-write skills, prompt composition |
| Runs | `runManager.ts` | run lifecycle, approvals/answers, ledger, history, journal, revert, resume |
| Orchestration | `orchestration/*` | `OrchestratedRun`, `roleRunner`, `recovery`/`faults` (v1 port: classify, stuck check, continue question, layer-0 retry, layer-1 split, scratch), `TaskGraph`, `LeaseManager`, `RunLedger`/`CostLimit`, `IdempotencyLog`, `writeGuard` snapshots, replacements |
| Setup | `assign.ts`, `recommend.ts`, `bench.ts`, `catalog.ts`(+`.data.json`), `setupContext.ts` | rules + AI assignment, benchmarks (`ModelPerf`), price catalog, workspace/hardware context |
| Misc | `history.ts`, `images.ts`, `mentions.ts`, `projectContext.ts`, `v1import.ts`, `debug/debug.ts` | |

## 3. Run paths (current reality)

| Path | Entry | Ledger/cost cap | Leases | Idempotency | Journal/resume | `maxRunHours` | Turn budget | Recovery |
|---|---|---|---|---|---|---|---|---|
| Direct | `RunManager.direct` → `drive` | no | yes (`taskId "direct"`) | no | no | own `capTimer` (`effectiveRunCapMs`) | `resolveLimits` | continue question only |
| Orchestrated | `RunManager.orchestrated` → `runOrchestrated` | yes | yes | yes | yes | orchestrator check | `resolveLimits` | layer 0/1 via `runTaskRecoverable` |
| Resume | `RunManager.resume` → `runTaskRecoverable` | yes | yes | yes | yes | orchestrator check | `resolveLimits` | layer 0/1 |

Limits: `limits.ts` `resolveLimits` (budget profile quick/normal/deep × model speed/cost/reliability factors, `maxWorkerTurnsCeiling`), called with copy-pasted args from `drive`, `orchestrator.ts`, `roleRunner.ts`.

`ToolLoop` is constructed in four places (`runManager.drive`, `orchestrator.ts`, `roleRunner.ts`, `bench.ts`), each resolving tools mode from `modelCaps`, limits, prompt and cost recording itself. `OrchestrationRuntime` is built twice in `runManager.ts` (resume, `driveOrchestrated`).

## 4. Model facts

Per `channel/model`, facts come from: `modelCaps` in `channels.yaml` (user, wins) ← probe cache (in-memory, `applyProbes`) ← bench `perf` ← catalog (`catalog.data.json`) / live `priceList`; agent `price` wins for cost. Merging happens in `core.ts` (`applyProbes`, probe handler), `recommend.ts` (price), `roles.ts` (`agentCaps`), `limits.ts` (catalog price fallback), and adapters (`ollama.ts` reads `numCtx`).

## 5. Config and state

- Files: `~/.config/stewart/{channels,agents,roles,settings}.yaml`, `skills/`; project `.stewart/{roles.yaml,skills/,scratch/}` (trusted workspaces only).
- State dir (HostPort): `ledger.jsonl`, run journals, `scratch/<runId>/{executed.jsonl,snapshots/}`, history.
- Secrets via HostPort only (`secretRef`).

## 6. In progress

- Budgets M5 done (`6d4ea05`: `taskSize.ts` classifier, `/quick` `/deep`); fault-recovery machinery ported (unblocks M6 escalation).
- Code-health skill + `code-health-reviewer` role — planned (`docs/2026-11-07-code-health.md`).

## 7. Known gaps vs v2 plan

- No v1 layer-2 fault note on re-plans, no `num_ctx` auto-detect; budget escalation (M6) still unbuilt (`BUDGETS_AND_SETUP_INFO.md` B4).
- Direct runs skip cost cap and ledger (§3).
- Probe cache not persisted across restarts (bench `perf` persisted via `modelCaps`).

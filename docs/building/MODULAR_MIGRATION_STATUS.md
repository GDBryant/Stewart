# Modular migration status (2026-11-07)

Snapshot of the §7 incremental migration in `docs/building/MODULAR_DESIGN.md`. Delete once §7 is complete.

## Verified state

- `pnpm -r build` / `pnpm -r typecheck` / `pnpm -r test`: green.
- `pnpm check:layers`: 22 modules ok.
- `node scripts/check-boundaries.mjs`: 0 violations, baseline empty.

## Committed (steps 0–7)

- Steps 0–1: scaffold + boundary lint warn mode.
- Step 2: pure leaves — kernel wire types, toolcall-format, compaction, scheduling, catalog, models, budget.
- Step 3: permissions, ledger.
- Step 4: HostPort split into narrow ports.
- Step 5 (M-5a..g): diagnostics, context, config, channels, roles-skills, tools, run-state, agent-loop.
- Step 6 (M-6a..b): effective config → roles-skills; `orchestration` + `recovery` extracted (`rt.recoveryService` = `createRecovery(runRoleTask)`; `OrchestrationRuntime`/`RecoveryState`/`RunRuntime` in `agent-loop` `runtime.ts`).
- Step 7: `RunManager` → `RunService` in `modules/runs` (`service.ts` + `direct/orchestrated/resume` strategies + `runtime.ts` `buildRunRuntime` + `parseCommand.ts`); `events.ts` → `kernel` (`EventBus`); `assign/recommend/bench/setupContext` → `modules/setup`; `core.ts` = composition root + `method → handler` table, handler bodies in `packages/core/src/handlers/{chat,config,setup,util}.ts` (app layer); `Core` internals used by handlers made public.
- Step 7 (interaction): `modules/interaction` (layer 2, deps kernel + protocol) owns the approval/ask/askTimed prompt cards and their resolve maps; `RunService` holds one `Interaction` and delegates `approve`/`answer`/`gate`/`askUser`/`askTimed`. `PromptGrant` mirrors `GrantDecision` (permissions is layer 3, can't be imported). 8 unit tests in the module.

- Audit (post M-7b): CI now runs `check:layers` + `check:boundaries`; all 22 module READMEs filled (purpose/owns/fake-it); stale manifest deps removed (`recovery→channels`, `orchestration→protocol`, unused `kernel` in six leaf modules); `MODULAR_DESIGN.md` §3 rewritten from the as-built manifests with §2 layer numbers, §6/§9 marked done/deferred, new §11 lists every sketch-vs-build deviation with its revisit trigger.

- §11 small items: `dependency-cruiser` 18.7.0 `check:cycles` (12 type-only cycles fixed via `runs/src/types.ts` `RunHost` and `core/src/handlers/types.ts` `CoreCtx`); per-package `vitest.config.ts` + `test:coverage` (90/80) on 27 packages; tsconfig `composite` + `references` via `scripts/sync-tsrefs.mjs` (`check:tsrefs`). All wired into CI. Coverage: all 27 packages meet 90/80 (tightest branches: orchestration 80.2, runs 80.6, setup 81.8); module-level tests moved out of `packages/core/test` into `orchestration`, `runs`, `setup`, `config`, no duplicates left; `conformance` has no `src` and passes vacuously.

- §11 #5 ProbeLoop seam: contract in `models/src/probe.ts`, `createProbeLoop` in `agent-loop/src/probe.ts`, `setup` drops `agent-loop` + `tools` deps; `benchModel` takes the probe, `Core.probeLoop` injects it.
- §11 #6 Interaction queue: FIFO `Interaction` with typed `Prompt<A>`/`PromptOutcome`/`pending()`; runtime `ask`/`askTimed` → `rt.prompt`; gate and prompts bound to the run signal (cancel withdraws); typed owner prompts for continue, plan gate, cost card, fallback, resume, ask_user; `ResumeRequest.ask` → `confirmResume`. Prompt text unchanged. Known: approval cards have no withdraw event, so a cancelled run's approval card stays in the webview (same as before).
- §11 #7 Permissions facade: `Permissions` (decide/ask/gate) in `modules/permissions` owns the session `Grants` and shows approval cards through the `Interaction` it is given; `permissions` gains `kernel` + `interaction` deps. `RunService.gate`/`sessionGrants` deleted; `RunHost` exposes `permissions`; `runtime.ts` wires `approve: svc.permissions.gate(run.id, signal)`. `grants()/revoke()/reset()` deferred until a `permissions.*` RPC appears (§11 deviation row).
- §11 #8 ChannelService facade: `ChannelService` (rebuild/get/require/ids/health/listModels/probe/setSecret) in `modules/channels` builds `ManagedChannel`s from config (maxParallel default ollama 1 / other 4, unknown types logged + skipped, secrets by ref returned for redaction). `Core.managed`/`rebuildChannels`/`channelById` deleted; `CoreCtx` exposes `channelService`; secret set/delete go through `setSecret`. `stream(agent, …)` deferred until a second consumer needs agent→channel resolution (§11 deviation row).
- §11 #9 RunStrategy plan: `RunStrategy<Req>` (`plan → RunPlan | Refusal`, `execute → RunOutcome`) + one `runPipeline` (plan → register + `run.started` → idem/journal/`buildRunRuntime` → execute → status/cost/journal/history/`run.finished`; exceptions → failed, timeCap cancelled in finally). `direct`/`orchestrated`/`resume` rewritten as plan/execute; `resume` is a `resumeStrategy(runId)` factory closing over the replayed graph; `{start}` objects and the three duplicated `drive` bodies deleted (strategy.ts +80, net -58 lines across the three files).

## Remaining

- **Step 8 (partly built):** file size is gated repo-wide (`check-boundaries`, F). Function limits (`max-lines-per-function` 40, `complexity` 10, `max-depth` 3, `max-params` 4) are gated by `scripts/check-functions.mjs` (TS-AST, same metrics as the eslint rules; deviation: no eslint dependency, offline-safe). 90 offenders are baselined (111 at first; the top 22 by complexity were refactored, 21 left the baseline — `recovery/split.ts::assembleFinalFile` stays for 5 params) in `scripts/functions.baseline.json` and ratcheted: new or grown ones fail. Work: refactor offenders in rank order (`pnpm check:functions --report`), `--update` after each batch. Next: continue in rank order.
- **Sketch deviations:** see `MODULAR_DESIGN.md` §11 (Result types, ChannelService/Permissions facades, setup session, RunStrategy.plan, …). Each has a stated trigger; none blocks step 8.
- Done-when (§7): no cycles, no deep cross-module imports (enforced by `exports`), every file within §1 limits (step 8), `Core` = table of one-line handlers (done), each module's tests run without constructing sibling/higher modules (Core-integration tests stay in `packages/core/test`; acceptable per §9 since they test the app layer).

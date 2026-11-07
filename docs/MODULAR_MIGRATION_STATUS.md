# Modular migration status (2026-11-07)

Snapshot of the §7 incremental migration in `docs/MODULAR_DESIGN.md`. Delete once §7 is complete.

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

## Remaining

- **Step 8 (deferred, decided):** full eslint rules per §6 — `max-lines` 300, `max-lines-per-function` 40, `complexity` 10, `max-depth` 3, `max-params` 4 — wired across all 22 modules + `packages/*`; extend `check-boundaries` size scan to `modules/*`; flip warn-with-baseline to error. Expect existing oversize files (`toolLoop.ts`, `orchestrator.ts`, `roleRunner.ts`, `runs/service.ts`, `runs/resume.ts`) to need splitting.
- **Sketch deviations:** see `MODULAR_DESIGN.md` §11 (Result types, ChannelService/Permissions facades, Interaction FIFO, ProbeLoop seam, setup session, coverage gate, tsconfig references). Each has a stated trigger; none blocks step 8.
- Done-when (§7): no cycles, no deep cross-module imports (enforced by `exports`), every file within §1 limits (step 8), `Core` = table of one-line handlers (done), each module's tests run without constructing sibling/higher modules (Core-integration tests stay in `packages/core/test`; acceptable per §9 since they test the app layer).

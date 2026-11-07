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

## Remaining §7 steps

- **`interaction` module** (layer 2) still empty — nothing maps to it yet in `scripts/boundaries.json` (map is now empty); decide whether ask/approval prompts move there (`runs` currently owns `ask`/`gate` directly) or drop the module.
- **Step 8:** flip boundary lint to error (`check-boundaries` currently warn-with-baseline; make it fail on any violation); ratchet file/function limits down (current `maxLines` 300).
- Done-when (§7): no cycles, no deep cross-module imports, every file within §1 limits, `Core` = table of one-line handlers (done: `core.ts` ~210 lines), each module's tests run without constructing sibling/higher modules (Core-integration tests still live in `packages/core/test` — e.g. `assign.test.ts`, `orchestration.test.ts` use `new Core(...)`/`new RunService(...)`; acceptable per §9 since they test the app layer).

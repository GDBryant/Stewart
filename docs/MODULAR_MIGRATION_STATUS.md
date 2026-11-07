# Modular migration status (2026-11-07)

Snapshot of the §7 incremental migration in `docs/MODULAR_DESIGN.md`. Delete once §7 is complete.

## Verified state

- `pnpm -r build` / `pnpm -r typecheck` / `pnpm -r test`: green.
- `pnpm check:layers`: 22 modules ok.
- `node scripts/check-boundaries.mjs`: 2 known violations (`size core.ts`, `size runManager.ts`), 0 new.

## Committed (steps 0–6)

- Steps 0–1: scaffold + boundary lint warn mode.
- Step 2: pure leaves — kernel wire types, toolcall-format, compaction, scheduling, catalog, models, budget.
- Step 3: permissions, ledger.
- Step 4: HostPort split into narrow ports.
- Step 5 (M-5a..g): diagnostics, context, config, channels, roles-skills, tools, run-state, agent-loop.
- Step 6 (M-6a..b): effective config → roles-skills; `orchestration` + `recovery` extracted (`rt.recoveryService` = `createRecovery(runRoleTask)`; `OrchestrationRuntime`/`RecoveryState`/`RunRuntime` in `agent-loop` `runtime.ts`).

## Remaining §7 steps

- **Step 7:** `RunManager` → strategies, thin `core.ts` to a router → fills `modules/runs` (layer 8). Also still in core: `assign.ts`, `recommend.ts`, `bench.ts`, `setupContext.ts` (→ `setup`, layer 7); `v1import.ts` stays (needs catalog); `interaction` module still empty; `events.ts` mapped to `kernel`.
- **Step 8:** flip boundary lint to error; ratchet file/function limits down.
- Done-when (§7): no cycles, no deep cross-module imports, every file within §1 limits, `Core` = table of one-line handlers, each module's tests run without constructing sibling/higher modules.

# @stewart/run-state

- Purpose: Per-run durable state: idempotency log, pre-image snapshots/revert, chat history
- Surface: `src/api.ts`
- Owns: `idempotency.ts` (`IdempotencyLog`, `hooks`), `snapshots.ts` (`recordPreImage`, `revertRunSnapshots`, lease errors), `history.ts` (`ChatHistoryStore`)
- Depends on: `@stewart/kernel` (lower layers only; `scripts/layers.json`)
- Fake it: Construct over `fakeHost()`; files live in its in-memory map

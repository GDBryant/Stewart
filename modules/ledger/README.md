# @stewart/ledger

- Purpose: Append-only cost ledger and per-run cost cap
- Surface: `src/api.ts`
- Owns: `ledger.ts` (`RunLedger` fsync'd JSONL + replay, `costOfCall`, `CostLimit`)
- Depends on: `@stewart/kernel` (lower layers only; `scripts/layers.json`)
- Fake it: `new RunLedger(fakeHost(), path, clock)`; `CostLimit` is pure

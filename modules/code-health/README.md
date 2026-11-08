# @stewart/code-health

- Purpose: Code-health report types, batching, aggregation, rendering
- Surface: `src/api.ts`
- Owns: `HealthReport`/`Finding`/`FileHealth` types, band thresholds, inventory batching (≤8 files / ≤3000 LOC), LOC-weighted aggregation, Markdown report rendering, health-request routing rule, source-file inventory filter.
- Depends on: see `package.json` (lower layers only; `scripts/layers.json`)
- Fake it: pure functions — call them directly, no fakes needed.

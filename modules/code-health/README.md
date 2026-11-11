# @stewart/code-health

- Purpose: Code-health report types, batching, aggregation, rendering
- Surface: `src/api.ts`
- Owns: `scan.ts` (masking + scan entry points) + `scanFunctions.ts` (per-function metric helpers), `HealthReport`/`Finding`/`FileHealth`/`ProjectCheck` types, band thresholds, inventory batching (≤8 files / ≤3000 LOC), LOC-weighted aggregation, Markdown report rendering (+ `measured` line and `Project checks:` section), health-request routing rule, source-file inventory filter; `metrics.ts`/`scan.ts`: lexical source scan (`scanMetrics`, `summarizeMetrics`, `renderMetricsSummary`, `renderMetrics`) — LOC, per-function branches/length/nesting, suppressions, evidence-only.
- Depends on: see `package.json` (lower layers only; `scripts/layers.json`)
- Fake it: pure functions — call them directly, no fakes needed.

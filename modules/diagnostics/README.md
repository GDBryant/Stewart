# @stewart/diagnostics

- Purpose: Debug log: leveled sink, redaction, retention, RunEvent entries
- Surface: `src/api.ts`
- Owns: `debug.ts` (`DebugLogger`, `DebugSink`, `NOOP_DEBUG_SINK`, `eventEntry`, redaction)
- Depends on: `@stewart/protocol` (lower layers only; `scripts/layers.json`)
- Fake it: Use `NOOP_DEBUG_SINK` or an array-collecting `DebugSink`

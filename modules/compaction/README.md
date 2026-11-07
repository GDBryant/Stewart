# @stewart/compaction

- Purpose: Context compaction as pure message transforms
- Surface: `src/api.ts`
- Owns: `compaction.ts` (measure, clip-to-note, `pruneStale`, `summarizeMiddle`)
- Depends on: `@stewart/kernel` (lower layers only; `scripts/layers.json`)
- Fake it: Pure; pass `ChatMessage[]` and a plan

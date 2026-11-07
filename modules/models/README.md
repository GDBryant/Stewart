# @stewart/models

- Purpose: One merge of caps/probe/bench/catalog/price into a `ModelProfile`
- Surface: `src/api.ts`
- Owns: `caps.ts` (`ModelCaps`, `ModelPerf`, `ToolsMode`, `DEFAULT_CAPS`, `isCosting`, `mergeProbeCaps`), `profile.ts` (`ModelProfile`, `resolveModelProfile`, `profileFromChannel`)
- Depends on: `@stewart/catalog` (lower layers only; `scripts/layers.json`)
- Fake it: Pure; build a `ModelProfile` literal in tests

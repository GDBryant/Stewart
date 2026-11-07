# @stewart/budget

- Purpose: Budget profiles, loop limits, task-size classifier
- Surface: `src/api.ts`
- Owns: `limits.ts` (`DEFAULT_BUDGET_PROFILES`, `budgetProfile`, `resolveLimits`, `effectiveRunCapMs`, `contextCharsFor`, `toolOutputCap`, `compactionThresholds`), `taskSize.ts` (`classifyTask`)
- Depends on: `@stewart/catalog`, `@stewart/models` (lower layers only; `scripts/layers.json`)
- Fake it: Pure; call with literal settings/profile objects

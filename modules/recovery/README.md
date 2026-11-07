# @stewart/recovery

- Purpose: Fault recovery service implementing agent-loop's `Recovery`: layer-0 retry, continue question, layer-1 split
- Surface: `src/api.ts`
- Owns: `service.ts` (`createRecovery(runOnce)`), `recover.ts`, `split.ts`, `brain.ts`, `plan.ts` (`parseRecoveryArgs`), `continue.ts` (`continueQuestion`, `mapContinueAnswer`), `scratch.ts` (scratch dir, gate, `roleWithScratch`), `consts.ts`
- Depends on: `@stewart/agent-loop`, `@stewart/config`, `@stewart/kernel`, `@stewart/permissions`, `@stewart/roles-skills`, `@stewart/scheduling`, `@stewart/tools` (lower layers only; `scripts/layers.json`)
- Fake it: Pure helpers are table-tested; for `runTask` pass a stub `runOnce` returning scripted `TaskResult`s

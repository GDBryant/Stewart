# @stewart/orchestration

- Purpose: Orchestrated runs: hub verbs, role task runner, replacement ranking
- Surface: `src/api.ts`
- Owns: `orchestrator.ts` (`runOrchestrated`, `resolveRole`, plan gate, nested dispatch), `roleRunner.ts` (`runRoleTask`, `buildRolePrompt`, `compactionFor`), `tools.ts` (`orchestrationTools`: dispatch/ask_user/submit_*), `prompts.ts` (typed plan gate / cost card / fallback prompts), `replacements.ts` (`freeCandidates`, `rankDeterministic`, `validateReplacements`)
- Depends on: `@stewart/agent-loop`, `@stewart/budget`, `@stewart/channels`, `@stewart/compaction`, `@stewart/config`, `@stewart/context`, `@stewart/interaction`, `@stewart/kernel`, `@stewart/ledger`, `@stewart/models`, `@stewart/permissions`, `@stewart/roles-skills`, `@stewart/run-state`, `@stewart/scheduling`, `@stewart/tools` (lower layers only; `scripts/layers.json`)
- Fake it: Build an `RunRuntime` (from `@stewart/run-contract`) with scripted channels and a `createRecovery(runRoleTask)` service; assert on emitted `RunEvent`s

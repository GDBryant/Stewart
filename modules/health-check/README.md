# @stewart/health-check

- Purpose: Code-health run feature: submit_health / health_report verbs, per-run report state, preflight and required role tools, plugged into orchestrated runs via RunFeature
- Surface: `src/api.ts`
- Owns: `feature.ts` (`healthCheckFeature`: terminal verb, orchestrator default tool, required role tools, preflight), `healthRun.ts` (`HealthRun`: per-run reports, merge, scratch write, lexical `Measured` line), `healthTools.ts` (`submit_health`/`health_report` tool specs)
- Depends on: `@stewart/run-contract`, `@stewart/tools`, `@stewart/code-health`, `@stewart/kernel` (lower layers only; `scripts/layers.json`); registered by the app in `packages/core/src/features.ts`, never imported by orchestration or runs (runs imports it in tests only)
- Fake it: `healthCheckFeature.createRun({ runId, host: fakeHost().host, config }, { tasks, maxOutputChars })` then call the tools from `taskTools(id)` / `orchestratorTools()`

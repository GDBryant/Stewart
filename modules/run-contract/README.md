# @stewart/run-contract

- Purpose: The run contract shared by orchestration, recovery and runs: the per-run runtime, task inputs/results and the recovery service interface
- Surface: `src/api.ts`
- Owns: `runtime.ts` (`RunRuntime`, `RoleTaskDeps`, `TaskResult`, `Recovery` + `RecoveryBrain`/`RecoveryContext`/`RunTaskOnce`, `RecoveryState`, `recoveryState(settings)`)
- Depends on: see `package.json` (lower layers only; `scripts/layers.json`); no dependency on `@stewart/agent-loop`
- Fake it: build a `RunRuntime` literal with `fakeHost()`, `{ emit }` and stub channels (see `modules/orchestration/test`)

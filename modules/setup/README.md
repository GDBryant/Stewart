# @stewart/setup

- Purpose: Setup assistance: rules scorer, AI-refined assignment, model benchmark, setup quick-probe queue, workspace/hardware scan
- Surface: `src/api.ts`
- Owns: `assign.ts` (`ROLE_PROFILES`, `scoreAssignments`, `meetsHardRequirements`), `recommend.ts` (`recommendAssignments`), `bench.ts` (`benchModel`, `BENCH_VERSION`), `probe.ts` (`SetupProbeRunner`, `smokeModel`, `normalizeReason`, `orderSmokeCandidates`, `rankCandidates`), `setupContext.ts` (`scanWorkspace`, `gatherHardware`)
- Depends on: `@stewart/catalog`, `@stewart/channels`, `@stewart/config`, `@stewart/kernel`, `@stewart/models`, `@stewart/roles-skills` (lower layers only; `scripts/layers.json`)
- Fake it: Scorer is pure; `recommendAssignments` takes a `Map<string, ManagedChannel>` of scripted channels; scan runs over `fakeHost()`

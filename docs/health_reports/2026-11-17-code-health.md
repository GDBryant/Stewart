# Repository Code Health Report

Date: 2026-11-17

## Scope and method

Reviewed source under `modules/`, `packages/`, and `hosts/`; docs, tests, and generated output excluded from structural scans. Scores are heuristic reviewer estimates, not CodeScene measurements. Branch counts from `scripts/complexity-scan.mjs`; nesting from a throwaway TypeScript-AST scan over 222 `src` files (Kotlin excluded). No clone detector, captured-state, or semantic cohesion analyzer was run.

## Category scores

| Category | Score | Evidence |
|---|---:|---|
| High complexity | 9.5/10 | 0 functions >15 branches, 2 >10 (`changeTracker` 13, `runOutcome` 11), 44 >8. `check:functions` reports 0 offenders. |
| Large units | 9/10 | 0 files >500 lines; 5 files at the >300 warning line (`assign.ts` 356, `taskRun.ts` 318, `session.ts` 316, `probe.ts` 308, `child.ts` 300). |
| Deep nesting | 10/10 | Corrected measure (the `check:functions` definition, which excludes else-if chains): max depth 3, 0 functions >=4; gate limit <=3. An earlier throwaway AST scan counted else-if/ternary and reported depth 5-6 — false positive. |
| Low cohesion | 8.5/10 | Module separation and dependency checks strong; no full semantic review. |
| Duplication | 7.5/10 | Provisional; no detector run. |
| Closure/state tangle | 7.5/10 | Provisional; no detector run. |
| Dead code | 8/10 | Naive scan: ~10 exported symbols never referenced (protocol wire types `JsonRpcRequest`/`CoreRequests`/etc. may be host contracts; `ProjectFile` config schema, `FsEntry` kernel testing). Needs verification. |
| Suppressions / weakened tests | 10/10 | 0 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`/`eslint-disable` in src; 0 `.skip`/`.only`/`xit`/`xdescribe`; 0 `: any`/`as any` in src. |
| Coupling / layering | 10/10 | All gates pass: layers (17 modules), boundaries, cycles (205 modules / 473 deps, 0 violations), tsrefs, functions, docs. |
| Coverage gaps | 9/10 | `pnpm test:coverage` passes all package thresholds; vscode 94.4/91.9, sidecar 98.5/90, evals 97.2/94.6. |
| Unstable hotspots | 7/10 | 14-day churn: `core.ts` 45, `runManager.ts` 33, `webview/state.ts` 31, `protocol/index.ts` 28, `roleRunner.ts` 25, `toolLoop.ts` 23. Churn concentrates in packages/core. |

## Change since 2026-11-10

- v3 rebuild landed: module set changed (17 modules; `packages/` now core/evals/protocol/sidecar/webview only). Largest file dropped 891 -> 356 lines.
- Docker compose defect fixed same day: `container_name` moved out of the shared anchor (`ollama` cpu / `ollama-gpu` gpu); combined cpu+gpu+webui profile validation passes.
- Still no ESLint config/dependency in the repo.

## Verification results

Passed: `pnpm -r test`, `pnpm test:coverage` (all package thresholds), `check:layers`, `check:boundaries` (0 violations, 5 size warnings), `check:cycles`, `check:tsrefs`, `check:functions` (0 offenders), `check:docs` (v3.0.4, 17 modules).

Failed: `docker compose -f docker/ollama/docker-compose.yml --profile cpu --profile gpu --profile webui config -q` (pre-existing defect; fixed later the same day — unique `container_name` per service, guarded by `scripts/ollama-compose.test.mjs`).

## Top improvements

1. ~~Reduce deep nesting~~ — withdrawn: false positive from a throwaway AST scan that counted else-if chains and ternaries; the official measure shows max depth 3 (gate limit <=3).
2. Split the 5 files at the >300 warning line before they hit 500 (setup/assign.ts, session/taskRun.ts, session/session.ts, setup/probe.ts, session/child.ts).
3. ~~Fix docker-compose `container_name` collision on `ollama-gpu`~~ — done 2026-11-17.
4. Reconcile the two complexity counters: complexity-scan flags `changeTracker` (13) and `runOutcome` (11) >10 while the functions gate passes; unify or tighten.
5. Verify/remove ~10 unused exports and add a dead-code check (knip/ts-prune) plus an ESLint baseline.

## Caveats

Nesting AST walk is a throwaway heuristic, not the `check:functions` counter. Duplication, captured state, and cohesion scores remain provisional. Gradle `buildPlugin`/`verifyPlugin` and the Kotlin test suite were not run for this report.

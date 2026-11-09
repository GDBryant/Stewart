# Repository Code Health Report

Date: 2026-11-09

## Scope and method

Reviewed source under `modules/`, `packages/`, and `hosts/`; excluded docs, tests-only files, and generated output from the structural scan. Test and coverage results were included separately.

Scores are heuristic reviewer estimates based on Stewart’s documented code-health categories, not CodeScene measurements. Branch counts come from `scripts/complexity-scan.mjs` (counts `if`/`switch`/`case`/ternary/loops/`catch`/`&&`/`||`/`??` per function). Function-length, file-size, and nesting counts come from a throwaway TypeScript-AST scan over 149 `src` files (function span = signature start to body end; nesting = max depth of `if`/loops/`switch`/`try`/`catch`/ternary inside each function). Kotlin was not included in those counts. The project’s orchestrated `code-health-reviewer` was not launched because it is available through the application workflow, not as a repository CLI command.

## Category scores

| Category | Score | Evidence |
|---|---:|---|
| High complexity | 7/10 | Complexity scan: 61 functions >10 branches, 8 >15 (was 79/38 at Phase-2 snapshot; Phase 4 refactored all 22 original >15 targets below 15). Largest remaining: `repairNativeCall`/`streamEvent`/`recordUsage` at 15. |
| Large units | 8/10 | Five source files exceed 500 lines (`shimParser.ts` 834, `SettingsView.tsx` 736, `probe.ts` 621, `state.ts` 579, `orchestrator.ts` 566); none exceed 1,000. 10 functions exceed 60 lines and 2 exceed 120 (`orchestrationTools` 181, `SetupWizard` 150). |
| Deep nesting | 8/10 | Post-pass AST scan: 0 functions reach depth ≥5 (was 8), 21 reach ≥4 (was 36), max depth 4 (was 6). Remaining depth-4 functions are mostly recently-refactored or adapter code deferred as risky churn. |
| Low cohesion | 8.5/10 | Module separation and dependency checks are strong; a full semantic cohesion review was not performed. |
| Duplication | 7.5/10 | No clone detector or exhaustive duplication review was run; provisional score. |
| Closure/state tangle | 7.5/10 | No captured-state detector was run; provisional score. |
| Dead code | 7.5/10 | No unused-export/dead-code analysis was run; provisional score. |
| Suppressions / weakened tests | 10/10 | Scan found no `@ts-ignore`, `@ts-expect-error`, `eslint-disable` in `src`; no `.skip`/`.only`/`xit`/`xdescribe` in tests (one grep hit was a false positive inside test helper code). |
| Coupling / layering | 10/10 | Layer, boundary, cycle, and TypeScript-reference checks passed (23 modules, 153 cruised modules / 299 deps, 0 violations). |
| Coverage gaps | 9/10 | `modules/kernel` gap fixed with new `result.ts`/`nodeFetch` tests (now 100% lines / 90.6% branches); full `pnpm test:coverage` passes all packages ≥90/80. `hosts/vscode` covers `routes.ts` 100%/97.4% with `extension.ts`/`host.ts` excluded as VS Code API-bound; `packages/conformance` remains effectively uninstrumented. |
| Unstable hotspots | 7/10 | Last-14-day churn concentrates in `packages/core` (`core.ts` 36, `runManager.ts` 33, `index.ts` 27 commits), `packages/webview`, JetBrains `ChatPanel.kt` (26+26), and docs/lockfile. Churn alone does not establish defect risk. |

## Change since 2026-11-08

- Complexity refactor (Phase 4, all 10 items) landed: scan `>10 branches` 79 → 61, `>15 branches` 38 → 8 across the plan's checkpoints (Phase 1: 81/79 → Phase 2: 78/31 → Phase 3: 72/22 → Phase 4 items 1–5: 68/15 → items 6–10: 61/8). The prior report's "32 functions >10 / 20 >15" used a different heuristic; the scan's own before/after is the comparable series.
- `hosts/vscode` gained coverage config (`@vitest/coverage-v8`, `vitest.config.ts`, `test:coverage`); `coverage/` added to `.vscodeignore` after it leaked into a VSIX.
- `modules/kernel` coverage gap fixed post-report with new `result.ts`/`nodeFetch` tests; full `pnpm test:coverage` then passed all packages.
- Nesting pass landed same day: all 8 depth-≥5 functions and 8 depth-4 functions flattened via extracted helpers/handler maps; scan now shows 0 functions ≥5, max depth 4.
- `scripts/build-install.sh` gained a no-pnpm fallback path; `pnpm-lock.yaml` updated for the vscode devDep.

## Verification results

Passed:

- `pnpm -r test` — all workspace packages green
- `pnpm -r typecheck`
- `pnpm -r build` — incl. sidecar bundle (dist/sidecar.cjs) and webview esbuild
- `pnpm test:coverage` — all packages ≥90% line / ≥80% branch (kernel fixed to 100%/90.6%)
- `pnpm check:layers` — 23 modules valid
- `pnpm check:boundaries` — 0 known or new violations
- `pnpm check:cycles` — no violations across 153 modules and 299 dependencies
- `pnpm check:tsrefs`
- `pnpm test:scripts` — 15 tests passed
- `hosts/vscode` `vitest run --coverage` — 33 tests, `routes.ts` 100% lines / 97.36% branches

Per-package coverage measured during the refactor work (all ≥90/80): permissions 100/99.3, agent-loop 97.4/90.6, runs 99.0/88.9, setup 96.0/84.7, orchestration 97.0/83.5, toolcall-format 94.1/86.2, webview 96.6/87.9, channels 97.1/86.4, recovery 97.6/87.0, config 97.4/88.0, kernel 100/90.6.

No repository ESLint configuration or dependency is defined. The available global ESLint binary has no project rule set to apply; the repository notes that broader ESLint limits are deferred.

## Caveats

Coverage was re-run end-to-end after the kernel fix and passed all packages; per-package line/branch numbers above are from focused runs during the same working tree. The throwaway AST scan's function-length and nesting definitions differ from the prior report's, so those deltas are directional; nesting counts were refreshed after the nesting pass (0 functions ≥5, max 4). `pnpm -r test`/`build`/`typecheck` tails showed clean completion but per-package counts were not re-enumerated. Duplication, captured state, cohesion, and dead code scores are less certain because no dedicated analyzers were run. Gradle `buildPlugin` was verified earlier via `scripts/build-install.sh --skip-vscode` (BUILD SUCCESSFUL) and was not re-run for this report.

# Repository Code Health Report

Date: 2026-11-08

## Scope and method

Reviewed source under `modules/`, `packages/`, and `hosts/`; excluded docs, tests-only files, and generated output from the structural scan. Test and coverage results were included separately.

Scores are heuristic reviewer estimates based on Stewart’s documented code-health categories, not CodeScene measurements. Branch, function-length, and nesting counts are a TypeScript/TSX syntax scan; Kotlin was not included in those counts. The project’s orchestrated `code-health-reviewer` was not launched because it is available through the application workflow, not as a repository CLI command.

## Category scores

| Category | Score | Evidence |
|---|---:|---|
| High complexity | 5.5/10 | 32 TS/TSX functions have more than 10 syntactic branches; 20 have more than 15. |
| Large units | 7/10 | Four source files exceed 500 lines; none exceed 1,000. 27 functions exceed 60 lines and six exceed 120. |
| Deep nesting | 6/10 | 20 functions reach nesting depth 4 or greater; 11 reach 5 or greater; maximum observed depth is 7. |
| Low cohesion | 8.5/10 | Module separation and dependency checks are strong; a full semantic cohesion review was not performed. |
| Duplication | 7.5/10 | No clone detector or exhaustive duplication review was run; provisional score. |
| Closure/state tangle | 7.5/10 | No captured-state detector was run; provisional score. |
| Dead code | 7.5/10 | No unused-export/dead-code analysis was run; provisional score. |
| Suppressions / weakened tests | 10/10 | Scan found no `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, skipped tests, or focused-only tests. |
| Coupling / layering | 10/10 | Layer, boundary, cycle, and TypeScript-reference checks passed. |
| Coverage gaps | 9/10 | Configured coverage gates passed; the VS Code host has no test files and conformance reported 0% instrumented coverage. |
| Unstable hotspots | 7/10 | Recent churn is concentrated in core and webview files; churn alone does not establish defect risk. |

## Verification results

Passed:

- `pnpm -r test`
- `pnpm -r build`
- `pnpm -r typecheck`
- `pnpm test:coverage`
- `pnpm check:layers` — 23 modules valid
- `pnpm check:boundaries` — 0 known or new violations
- `pnpm check:cycles` — no violations across 144 modules and 267 dependencies
- `pnpm check:tsrefs`
- `pnpm test:scripts` — 15 tests passed

Focused checks also passed: code-health tests (16), code-health typecheck and coverage (100% lines, 85% branches), VS Code typecheck, and `WorkspaceFilesTest` with Gradle rerunning tasks.

No repository ESLint configuration or dependency is defined. The available global ESLint binary has no project rule set to apply; the repository notes that broader ESLint limits are deferred.

## Caveats

The working tree changed while the broad checks were running, so those results may predate some of the edits observed during the audit. The affected code-health and host areas were rechecked with the focused commands above. Duplication, captured state, cohesion, and dead code scores are less certain because no dedicated analyzers were run.

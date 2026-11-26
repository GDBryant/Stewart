# Project Health Report — 2026-11-26

Scope: whole repo (~525 source files, ~59k lines: TS/TSX modules+packages, Kotlin JetBrains host, VS Code host, scripts).
Method: the project's own gates were run (no per-file manual audit). Working tree had uncommitted changes (setup, core models, webview).

## Verified results

| Check | Result |
|---|---|
| `check:layers` | ok, 19 modules |
| `check:boundaries` | 0 violations; 9 files over the 300-line warning (none >500) |
| `check:cycles` | no violations (261 modules, 598 deps) |
| `check:tsrefs` | in sync |
| `check:docs` | ok (v3.0.14, 19 modules) |
| `check:functions` | ok, 0 baselined offenders |
| `pnpm -r typecheck` | clean, all packages |
| `pnpm -r test` | exit 0; all listed packages pass (e.g. webview 268, session 215, tools 193, engines 172, channels 112) |
| `@ts-ignore` / `any` in src | 2 occurrences |
| TODO/FIXME in src | none real (only the `new-module` template and eval fixtures) |

## Findings

Files near the size limit (warning >300, fail >500), candidates for splitting:
- `modules/engines/src/nativeLoop.ts` (434), the closest to the limit
- `modules/tasks`/`session`: `session/src/taskRun.ts` (378), `session/src/session.ts` (348), `tasks/src/changes.ts` (314)
- `modules/setup/src/assign.ts` (369), `setup/src/probe.ts` (309)
- `packages/webview/src/stateHandlers.ts` (368), `packages/core/src/handlers/setup.ts` (312)
- `hosts/jetbrains/.../StewartProjectService.kt` (329)

Minor:
- Two uses of `any`/`@ts-ignore` in src. Locate with `grep -rnE "@ts-ignore|@ts-expect-error|: any\b|as any\b"`.
- `modules/setup`, `packages/core`, `packages/sidecar` and `packages/evals` test summaries were not captured in the filtered output (overall exit 0).

## Not verified

- Coverage thresholds (`pnpm test:coverage`, ≥90% line / ≥80% branch) were not run.
- JetBrains Gradle tests (`./gradlew test koverVerify`) were not run.
- No per-file manual review (66-batch auditor pass) was done; the earlier attempt timed out (504).

## Overall

Healthy. All enforced gates are green; the only drift signal is nine files in the 300–434 line range.

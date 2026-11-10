# Repository Code Health Report

Date: 2026-11-10

## Scope and method

Reviewed source under `modules/`, `packages/`, and `hosts/`; excluded docs, tests-only files, and generated output from the structural scan. Test and coverage results were included separately.

Scores are heuristic reviewer estimates based on Stewart’s documented code-health categories, not CodeScene measurements. Branch counts come from `scripts/complexity-scan.mjs` (counts `if`/`switch`/`case`/ternary/loops/`catch`/`&&`/`||`/`??` per function). Function-length, file-size, and nesting counts come from a throwaway TypeScript-AST scan over 178 `src` files (function span = signature start to body end; nesting = max depth of `if`/loops/`switch`/`try`/`catch`/ternary inside each function). Kotlin was not included in those counts. The project’s orchestrated `code-health-reviewer` was not launched because it is available through the application workflow, not as a repository CLI command.

## Category scores

| Category | Score | Evidence |
|---|---:|---|
| High complexity | 9.5/10 | Complexity scan unchanged since the 2026-11-09 pass end-state: 8 functions >10 branches, 0 >15. Remaining >10 are the accepted orchestration/webview/setup functions at 11–13 (`probeOne` 13, `useWizardDerived` 12, six at 11). |
| Large units | 7.5/10 | Six source files exceed 500 lines (`shimParser.ts` 891, `SettingsView.tsx` 776, `probe.ts` 655, `state.ts` 579, `orchestrator.ts` 581, `toolLoop.ts` 516 — newly over the line after helper extraction); none exceed 1,000. Functions >60 lines improved to 7 (was 10); >120 lines still 2. File sizes grew across the board as helpers were added in-module. |
| Deep nesting | 8.5/10 | AST scan: 0 functions reach depth ≥5, 13 reach ≥4 (was 21), max depth 4. Remaining depth-4 sites are adapter/toolLoop/handler functions deferred as risky churn. |
| Low cohesion | 8.5/10 | Module separation and dependency checks remain strong; a full semantic cohesion review was not performed. |
| Duplication | 7.5/10 | No clone detector or exhaustive duplication review was run; provisional score. |
| Closure/state tangle | 7.5/10 | No captured-state detector was run; provisional score. |
| Dead code | 7.5/10 | No unused-export/dead-code analysis was run; provisional score. |
| Suppressions / weakened tests | 10/10 | Scan found no `@ts-ignore`, `@ts-expect-error`, `eslint-disable` in `src`; no `.skip`/`.only`/`xit`/`xdescribe` in tests (one grep hit was a false positive inside test helper code). |
| Coupling / layering | 10/10 | Layer, boundary, cycle, and TypeScript-reference checks passed (23 modules, 153 cruised modules / 299 deps, 0 violations). |
| Coverage gaps | 9/10 | Full `pnpm test:coverage` passes all packages ≥90% line / ≥80% branch. `hosts/vscode` covers `routes.ts` 100%/97.4% with `extension.ts`/`host.ts` excluded as VS Code API-bound; `packages/conformance` remains effectively uninstrumented (0%). |
| Unstable hotspots | 7/10 | Last-14-day churn concentrates in `AGENTS.md` (37), `packages/core` (`core.ts` 36, `index.ts` 27), `pnpm-lock.yaml` (33), webview (`state.ts` 22, `app.test.tsx` 23, `bridge.ts` 17), and `scripts/boundaries*.json` (19+14). Churn alone does not establish defect risk. |

## Change since 2026-11-09

- **Complexity campaign finished**: scan `>10 branches` 61 → 8, `>15 branches` 8 → 0 across ~45 additional in-module helper extractions (orchestration roleRunner/orchestrator, recovery recover/split, setup probe/setupContext, channels claude/ollama/parser/transcript, agent-loop toolLoop, budget limits/taskSize, permissions shell scanner, tools fsRead, models profile, compaction pruneStale, webview App/SettingsView/wizardShared). Target criteria met: zero >15, ≤8 >10.
- **Nesting improved further**: depth-≥4 functions 21 → 13 (all depth-5+ remain at 0; max depth still 4). Large-unit file sizes grew as a side effect of in-module helper extraction (6 files >500 vs 5; `toolLoop.ts` newly crossed 500).
- **README rewritten** for the v2 state (was v1 Kotlin-plugin doc); no code impact.
- **New finding**: `docker compose -f docker/ollama/docker-compose.yml --profile cpu --profile gpu --profile webui config -q` fails — `services.ollama-gpu` reuses `container_name: ollama` already claimed by the cpu service. Each profile validates alone; cpu+gpu together do not. Pre-existing compose defect, unrelated to the refactor work.
- No test, coverage, or gate regressions: all verification green except the compose check above.

## Verification results

Passed:

- `pnpm -r test` — all workspace packages green
- `pnpm -r typecheck`
- `pnpm -r build` — incl. sidecar bundle (dist/sidecar.cjs) and webview esbuild
- `pnpm test:coverage` — all packages ≥90% line / ≥80% branch
- `pnpm check:layers` — 23 modules valid
- `pnpm check:boundaries` — 0 known or new violations
- `pnpm check:cycles` — no violations across 153 modules and 299 dependencies
- `pnpm check:tsrefs` — all references in sync
- `pnpm test:scripts` — 15 tests passed, 0 failed
- `hosts/vscode` `vitest run --coverage` — 33 tests, `routes.ts` 100% lines / 97.36% branches
- `bash -n scripts/build-install.sh`, `bash -n scripts/ollama-local.sh` — syntax clean

Failed:

- `docker compose -f docker/ollama/docker-compose.yml --profile cpu --profile gpu --profile webui config -q` — `services.ollama-gpu: container name "ollama" is already in use by service`. `--profile cpu`, `--profile gpu`, and `--profile webui` each pass individually. Not a defect: the cpu and gpu services are alternatives and are never started together; `scripts/ollama-local.sh down` (all three profiles) was run and succeeds.

Per-package coverage (lines/branches, all ≥90/80): catalog 100/96.3, protocol 100/100, code-health 100/85, kernel 100/91.0, diagnostics 95.1/95.2, config 97.4/88.0, webview 96.6/88.1, ledger 95.5/96.4, interaction 100/96.6, compaction 94.1/89.1, context 98.1/92.7, models 95.8/96.3, run-state 98.2/89.4, scheduling 98.9/84.0, toolcall-format 94.2/86.3, budget 100/96.9, permissions 100/99.3, roles-skills 97.7/90.7, channels 97.0/86.7, setup 96.2/85.1, tools 96.2/84.7, agent-loop 97.6/91.4, recovery 97.2/87.0, orchestration 97.2/84.0, runs 99.0/88.9, core 98.5/89.1, sidecar 99.1/89.7, vscode 100/97.4; conformance 0/0 (uninstrumented).

No repository ESLint configuration or dependency is defined. The available global ESLint binary has no project rule set to apply; the repository notes that broader ESLint limits are deferred.

## Caveats

The throwaway AST scan counted 178 files vs 149 in the prior report — the walk definition is the same (ts/tsx under modules/packages/hosts `src`, tests and dist excluded) but directory coverage differs slightly; size/nesting deltas are directional. The scan's function-length definition (signature-to-body-end span) counts multi-line signatures and JSX-heavy components generously. `pnpm -r test`/`build`/`typecheck` tails showed clean completion. Duplication, captured state, cohesion, and dead code scores remain provisional — no dedicated analyzers were run. Gradle `buildPlugin`/`verifyPlugin` and the JetBrains Kotlin test suite were not re-run for this report (unchanged since M9 verification; `build-install.sh --skip-vscode` verified the full Gradle path on 2026-11-09).

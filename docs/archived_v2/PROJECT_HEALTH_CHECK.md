# Project Health Check: orchestrated code-health over the whole codebase

**Goal:** "Check the health of this project" makes the Orchestrator inventory the project's *source files*, fan them out in batches to `code-health-reviewer` (rubric in the `code-health` skill), and return one deterministic, aggregated report. Docs are never the subject of a health check.

**Observed failure:** the run read `docs/` and compared "phase 1 vs phase 2". Causes, from the code as built:
1. No routing rule. `orchestrate` (`modules/roles-skills/src/defaults/skills.ts:14`) says nothing about health checks; the Orchestrator holds `ReadFile`/`FindFiles` and its prompt ends with `AGENTS.md` (`modules/context/src/projectContext.ts:9`), whose only "health"/"phase" words are doc references, so it followed them.
2. No file inventory. `FindFiles` (`modules/tools/src/fsRead.ts:74`) returns ≤500 unordered paths with no sizes and does not skip `dist`/generated output; `code-health` tells the reviewer to sample "max 20 files" when given a folder.
3. No aggregation. Each dispatch result is clipped at `ORCHESTRATOR_MAX_TOOL_OUTPUT = 4_000` chars (`modules/orchestration/src/orchestrator.ts:32`); a batch report with findings exceeds that, and the Orchestrator LLM would have to add LOC-weighted scores by hand.
4. `code-health-reviewer` ships `enabled: false` (`modules/roles-skills/src/defaults/roles.ts:65`); the wizard does not assign it, so the Orchestrator has no role to dispatch to.

## Architecture decisions
- **Inventory is deterministic, not LLM-driven.** New project tool `ListCodeFiles` returns source files with LOC, sorted LOC-desc. The Orchestrator uses it; the reviewer never globs on a project-wide run.
- **Reviewer output becomes structured.** New core-handled terminal verb `submit_health` (same pattern as `submit_plan`, `TERMINAL` in `roleRunner.ts:25`). Text output contract stays for direct/single-file use; the structured verb is mandatory when the briefing contains `Report via submit_health`.
- **Aggregation is code, not prose.** New module `code-health` (layer 3, beside `roles-skills`) owns the report types, batching, scoring math and Markdown rendering. Orchestration imports it; the Orchestrator calls `health_report` to get the final text and returns it verbatim.
- **Routing lives in the skill text plus a tested helper.** `isHealthCheckRequest(text)` (keyword rule: health/healthy/score the code/code health + project/codebase/repo/this code) is unit-tested; the `orchestrate` skill body states the procedure. Rationale: the model decides, but the test pins the vocabulary the skill must mention.
- **Scope default:** source dirs only; exclude tests (`**/test/**`, `*.test.*`, `*.spec.*`), `dist`, `build`, `out`, `node_modules`, `.*`, generated (`*.d.ts`, `*.min.*`, lockfiles). Include tests only when the request says so.
- **Batch size:** ≤8 files and ≤3,000 LOC per batch; a file >3,000 LOC is its own batch and flagged `large file, truncated review` if `ReadFile` cannot return it whole (`MAX_FILE_BYTES`).
- **Persistence:** full report written to `.stewart/scratch/health/<runId>.md` (already an allowed write path) so the chat answer can be short.

## Interfaces (settled)

```ts
// modules/code-health/src/types.ts
export type Band = "Green" | "Yellow" | "Red";
export interface FileHealth { path: string; loc: number; score: number; band: Band }
export interface Finding { path: string; line?: number; smell: string; severity: "high" | "med" | "low"; refactor: string }
export interface HealthReport { files: FileHealth[]; findings: Finding[]; notChecked: string[] }
export interface InventoryEntry { path: string; loc: number }
export interface Aggregate { score: number; band: Band; files: number; loc: number; red: FileHealth[]; worst?: FileHealth; bySmell: Record<string, number>; notChecked: string[] }

export function bandFor(score: number): Band;                     // ≥9.5 Green, ≥7.0 Yellow, else Red
export function batchInventory(files: InventoryEntry[], max = { files: 8, loc: 3000 }): InventoryEntry[][];
export function mergeReports(reports: HealthReport[]): HealthReport; // dedupe by path, last wins
export function aggregate(report: HealthReport): Aggregate;         // LOC-weighted mean, round 0.1
export function renderReport(a: Aggregate, r: HealthReport, mode: "score" | "issues"): string;
export function isHealthCheckRequest(text: string): boolean;
export function isSourceFile(path: string, opts?: { includeTests?: boolean }): boolean;
```

`ListCodeFiles` tool (`modules/tools/src/fsRead.ts`): params `{ path?: string; include_tests?: boolean }`; output one line per file `"<path>\t<loc>"`, LOC-desc, plus `[n more]` after `MAX_FIND_RESULTS`. Uses `paths.list` + `paths.read` for line counts; skips files > `MAX_FILE_BYTES` with `"<path>\t?"`.

`submit_health` verb (`modules/orchestration/src/tools.ts`): args = `HealthReport`; `coreHandled`, ends the turn; handler stores the report keyed by task id and returns `"Health report recorded: n files, mean x/10, worst <path> y/10"` (this short string becomes the task summary, so it fits the 4,000-char clip).

`health_report` verb (Orchestrator only): args `{ mode?: "score" | "issues" }`; merges all recorded reports, writes `.stewart/scratch/health/<runId>.md`, returns the rendered text (clipped to the tool cap with a `see <path>` tail).

## Tasks

### Task 1: `code-health` module — pure logic
- [x] `node scripts/new-module.mjs code-health "Code-health report types, batching, aggregation, rendering"`; add to `scripts/layers.json` at layer 3; `node scripts/sync-tsrefs.mjs`.
- [x] Implement the functions above. `renderReport` emits: line 1 `Scope: project · Mode: <m> · Checked: n files / loc LOC · Not checked: …`; `Overall: x/10 (Band)`; `Red files:` list; per-file score lines LOC-desc; in `issues` mode findings `path:line | smell | sev | refactor` ordered high→low.
- [x] Tests (positive + negative): `bandFor` at 9.5/9.4/7.0/6.9; `batchInventory` splits on both limits and isolates a >3,000-LOC file; `mergeReports` dedupes; `aggregate` LOC-weighting (two files 100 LOC @10 and 900 LOC @5 → 5.5), empty report → `score 0`, `files 0`, no throw; `isHealthCheckRequest` true for "check the health of this project", "code health score for the repo", false for "is the server healthy", "health endpoint test", "compare phase 1 and phase 2 docs"; `isSourceFile` accepts `.ts .tsx .js .kt .java .py .go .rs .mjs .cjs`, rejects `dist/`, `node_modules/`, `*.d.ts`, `*.test.ts` by default and accepts tests with `includeTests`.
- Verification: `pnpm --filter @stewart/code-health test`, `pnpm check:layers`, `pnpm check:cycles`, `pnpm check:tsrefs`.
- Files: `modules/code-health/**`, `scripts/layers.json`, tsconfig refs. Scope: M.

### Task 2: `ListCodeFiles` tool
- [x] Add class in `modules/tools/src/fsRead.ts`; register in `projectTools`; export from `api.ts`. Filtering via `isSourceFile` (tools layer 5 may import layer 3).
- [x] Tests in `modules/tools/test`: returns LOC-desc with tab separator; excludes `dist/`, tests, dotdirs; `include_tests: true` includes them; `path` outside workspace throws `path escapes workspace`; oversize file reported as `?`.
- [x] Add `ListCodeFiles` to `orchestrator` and `code-health-reviewer` tools in `defaults/roles.ts`; update the roles tests that assert tool lists.
- Verification: `pnpm --filter @stewart/tools test`, `pnpm --filter @stewart/roles-skills test`.
- Files: `fsRead.ts`, `tools/src/index|api.ts`, `tools/test/*.ts`, `defaults/roles.ts`, `roles.test.ts`. Scope: M.

### Task 3: `submit_health` + `health_report` verbs
- [x] `tools.ts`: add both verbs to `OrchestrationHandlers` and `orchestrationTools`; `submit_health` schema mirrors `HealthReport` (`additionalProperties: false`, severities enum, band enum).
- [x] `roleRunner.ts`: add `submit_health` to `TERMINAL`.
- [x] `orchestrator.ts`: `OrchestratedRun.healthReports = new Map<taskId, HealthReport>()`; `roleVerbs` exposes `submit_health` when the role lists it; `ORCHESTRATOR_DEFAULT_TOOLS` gains `health_report`; handler merges, aggregates, writes scratch file via `rt.host.files.write`, returns rendered text. Nested roles get `"Reports are aggregated by the Orchestrator."` for `health_report`.
- [x] `defaults/roles.ts`: `code-health-reviewer.tools` += `submit_health`; `orchestrator.tools` += `health_report`.
- [x] Tests in `modules/orchestration/test/orchestration.test.ts` (reuse the scripted-channel harness around `runRoleTask`/`runOrchestrated`): a reviewer task calling `submit_health` ends the turn and its summary is the short line; malformed `submit_health` (missing `files`) is rejected by schema and the loop continues; `health_report` with two recorded reports returns LOC-weighted overall and writes `.stewart/scratch/health/<runId>.md`; `health_report` with none returns `"No health reports recorded."`; a non-orchestrator role cannot call `health_report`.
- Verification: `pnpm --filter @stewart/orchestration test`, `pnpm -r typecheck`.
- Files: `tools.ts`, `roleRunner.ts`, `orchestrator.ts`, `defaults/roles.ts`, `orchestration.test.ts`. Scope: L → if it grows past 5 files, split verbs (3a) from orchestrator wiring (3b).

### Checkpoint A (after Tasks 1–3)
- [x] `pnpm -r test && pnpm -r typecheck && pnpm check:layers && pnpm check:cycles && pnpm check:tsrefs` green.

### Task 4: Routing + skill text
- [x] `orchestrate` skill body: add the procedure — `Project health check ("check/score the health of the project/codebase"): never read docs; call ListCodeFiles; batch ≤8 files/≤3000 LOC; dispatch one code-health-reviewer task per batch in the same turn with the exact file list and "Report via submit_health"; when all are done call health_report and return its text verbatim. If code-health-reviewer is disabled, ask the user to enable it; do not substitute another role.`
- [x] `code-health` skill body: when the briefing lists files, score every listed file (no 20-file cap); the cap applies only to self-resolved folders; if told to `Report via submit_health`, submit the structured report instead of text.
- [x] `code-health-reviewer` prompt: mention `submit_health`.
- [x] Tests (`modules/roles-skills/test/skills.test.ts`, `packages/core/test/skills.test.ts`): orchestrate body contains `ListCodeFiles`, `health_report`, `code-health-reviewer`, `never read docs`; code-health body contains `submit_health` and `every listed file`; negative: orchestrate body does not contain `phase`; `composeRolePrompt` for the orchestrator with the default budget is not truncated (guards the longer skill).
- Verification: `pnpm --filter @stewart/roles-skills test`, `pnpm --filter @stewart/core test`.
- Files: `defaults/skills.ts`, `defaults/roles.ts`, two test files. Scope: S.

### Task 5: Role availability
- [x] `modules/setup/src/assign.ts`: include `code-health-reviewer` in the default assignment set so the wizard binds an agent (keep `enabled: false` in shipped YAML; the wizard flips it like other roles — confirm against the wizard's enable path before editing).
- [x] Orchestrator fallback: when `isHealthCheckRequest(userText)` and `resolveRole(rt, "code-health-reviewer")` is undefined, `runOrchestrated` returns `failed` with `code-health-reviewer is not enabled; enable it in roles.yaml or rerun setup` instead of letting the model improvise. Test both branches.
- Verification: `pnpm --filter @stewart/setup test`, `pnpm --filter @stewart/orchestration test`.
- Files: `assign.ts`, `orchestrator.ts`, tests. Scope: S.

### Checkpoint B (after Tasks 4–5): manual smoke
- [ ] Run "check the health of this project" in VS Code against Stewart itself. Expect: `ListCodeFiles` call, N parallel reviewer tasks in the graph, one `health_report`, answer begins `Scope: project`, scratch file exists, no `docs/` reads in the transcript.
- [ ] Run "score only" variant → no findings lines. Run "check health of modules/tools" → single-folder path still works via the existing skill (no `ListCodeFiles` required).
- [ ] Record results in `docs/ai_docs/PROGRESS.md`.

### Task 6: Docs
- [x] `docs/ai_docs/ARCHITECTURE_NOW.md`: new module row, new tool, new verbs, health-check run path (same commit as Task 3).
- [x] `docs/ai_docs/PROGRESS.md` row; `docs/building/MODULAR_DESIGN.md` §3 table row for `code-health`.
- [x] `AGENTS.md` reference already added for this plan.
- Verification: `pnpm -r build && pnpm -r test`.

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Model ignores `submit_health` and returns text | Report missing a batch | `health_report` lists tasks without a report under `Not checked`; Task 3 test covers it |
| Large repos → many batches, cost/turn limits | Partial run | Batches respect `rt.cost`; parked tasks reuse the existing cost-limit flow; report marks parked batches `not checked` |
| JetBrains host `files.list` may not skip `node_modules` | Inventory noise | `isSourceFile` excludes by path regardless of host; verify in the Kotlin host during Checkpoint B |
| Orchestrator skill budget truncation | Routing text cut | Task 4 test on `composeRolePrompt.truncated === false` |
| Heuristic scores vary between batches/models | Inconsistent bands | Same model per role; report states "LLM heuristic" once; findings carry `path:line` so they can be checked |

## Open questions
- Should `health_report` also be written under `docs/` (committable) or stay in `.stewart/scratch`? Plan assumes scratch.
- Include test files by default? Plan assumes no unless the request says "including tests".
- Kotlin (`hosts/jetbrains`) counted as source by default? Plan assumes yes (`.kt`, `.java`).

## Generic metrics + project checks (built)

`@stewart/code-health` now ships `metrics.ts`/`scan.ts`: a dependency-free lexical scanner (brace-family + Python/Ruby indent) reporting LOC, per-function branches/length/nesting and suppressions for any project language, exported as `scanMetrics`/`summarizeMetrics`/`renderMetricsSummary`/`renderMetrics`. The `CodeMetrics` tool (`@stewart/tools`) exposes it to roles; `code-health-reviewer` holds it plus `RunTerminal` (restricted to the 'Project checks' task, which detects the project's test/coverage command and submits `checks` via `submit_health`). `health_report` adds a `Measured (lexical scan, approximate)` line computed from the merged file paths and a `Project checks:` section. Metrics are evidence only — the reviewer still judges scores — and the scan is a lexical approximation (no AST), so numbers can differ slightly from `scripts/complexity-scan.mjs`.

# Evals

Outcome eval suite (`docs/archived_v3/NEW_DESIGN_2026-11-13.md` §6 step 0). Each build step ends with a run and its pass rate recorded here.

## Suite

- Package: `packages/evals` (`@stewart/evals`). Fixture repo `fixture/base` + `fixture/last-commit` (second commit adds `truncate`); one planted failing test (`range.js` off-by-one) and one planted bug (`cart.js` discount applied twice).
- 15 tasks in `src/tasks.ts`, scored by code (`src/kit.ts`): 5 question, 7 edit (incl. a two-turn follow-up), 2 report, 1 three-milestone build. Every task has a reference solution that passes and a negative that fails (`test/tasks.test.ts`).
- Runner: real `Core` per task over a temp git repo with a Node `HostPort` (`src/nodeHost.ts`); approvals auto-granted once, questions answered with the first option. Pass = the task check; `statusAgrees` = run status `done` iff the check passed.
- Qualification: before the tasks, the runner copies the config, removes every `qualified` record and runs the real `setup.qualify` suites for each agent an enabled role binds (`src/qualify.ts`). Tasks run on that copy, so an agent takes part only if it passed in this run; the verdicts are printed and stored as `qualification` in the results file. `--skip-qualify` trusts the records already in the config. The shipped eval configs carry no records.
- Secrets: `STEWART_SECRET_<REF>` env vars (e.g. `STEWART_SECRET_CHANNEL_AI_FACTORY`), also read from gitignored `packages/evals/.env`.

## Run

```
pnpm -r build
cd packages/evals
node dist/main.js --label <name> [--config <dir>] [--disable-lead] [--only id,id] [--parallel n] [--keep never|failed|always] [--skip-qualify]
```

`--config` defaults to `~/.config/stewart` (copied per task). Shipped eval configs: `configs/lead-glm` (native-loop, AI Factory glm-5-3-flash), `configs/lead-claude` (claude-code, sonnet), `configs/lead-chain-local` (local qwen → sonnet), `configs/lead-chain-aif` (local qwen → AI Factory glm-5-3-flash). Since the 2026-11-20 primary/secondary change a role binds at most two agents; `lead-chain-aif` previously escalated over 4, so its older recorded pass rates are not comparable. Results: `packages/evals/results/<date>-<label>.json`; failed task workspaces are kept under `/tmp/stewart-eval-*`.

## Results

| Date | Step | Label | Config | Pass | Status agrees | Cost | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-12 | 0 | baseline | user config, `--disable-lead` (orchestrator path) | 11/15 (73.3%) | 8/15 | $0 | AI Factory returned HTTP 500 on every chat request during the run, so roles bound to it failed. 3 passes ended `no_dispatch`; 2 ended `timeout`; fails: diff summary, rename (broke `strings.js`), function+test (no test), todo CLI |
| 2026-11-12 | 2 | step2-claude-sonnet | `configs/lead-claude` | 15/15 (100%) | 15/15 | $1.65 | lead path, claude-code engine |
| 2026-11-12 | 1 | step1-glm | `configs/lead-glm` | 14/15 (93.3%) | 13/15 | $0.33 | e-new-file failed on default-export `greet`; l-todo-cli passed but status disagreed |
| 2026-11-12 | 1 | step1-glm-newfile-recheck | `configs/lead-glm`, e-new-file only | 1/1 (100%) | 1/1 | $0.02 | after `e-new-file` check accepted default exports |
| 2026-11-12 | 6 | v3-cutover-claude | `configs/lead-claude` | 15/15 (100%) | 15/15 | $1.65 | after deleting the v2 run path |
| 2026-11-12 | 4 | step4-claude | `configs/lead-claude` | 15/15 (100%) | 15/15 | $1.67 | regression after steps 3–4 |
| 2026-11-12 | 4 | step4-chain-local | `configs/lead-chain-local` (qwen3.5:4b → sonnet) | 13/15 (86.7%) | 13/15 | $0.36 | 3 escalated to sonnet (rename, function+test, todo CLI), 10 finished on qwen3.5:4b; 2 wrong results reported `done`: CommonJS `greet.js` in an ESM project, folder review answered from diagnostics without citations |
| 2026-11-12 | 5 | step5-claude | `configs/lead-claude` | 15/15 (100%) | 14/15 | $1.68 | l-todo-cli: work correct but M3 never marked done → `plan incomplete`; fixed by the end-of-turn milestone sweep |
| 2026-11-12 | 5 | step5-chain-local | `configs/lead-chain-local` | 13/15 (86.7%) | 13/15 | $0.42 | 3 escalated; wrong `done`: rename broke `index.js` export, folder review without citations |
| 2026-11-12 | 5 | step5-claude-todo | `configs/lead-claude`, l-todo-cli only | 1/1 | 0/1 | $0.21 | after the sweep: the model chose `npm test` as M3 check, which fails on the planted range bug → honest `failed` |
| 2026-11-12 | 3 | step3-local | local Ollama, 3 tasks | 2/3 (66.7%) | 3/3 | $0 | question 1/1, report 1/2 (recorded from `results/2026-11-12-step3-local.json`) |

The §8 build (gaps 1–8 of the design's §8) was verified by unit tests and the code gates; **evals not re-run** — re-run steps 1, 4, 5 before the next release.

2026-11-13 audit fixes (design §8.4): `l-todo-cli` now also requires `.stewart/plan.md` done with ≥3 milestones, each with an existing checkpoint (`planCompleted`), so earlier `l-todo-cli` passes are not comparable. Edit requests that change no file now fail (`edit request: no file changed`), and setup refuses unqualified models. Evals not re-run.

### 2026-11-13 after the §8.5 fixes (working tree on `59dab07`)

Each run qualified its agents first; `l-todo-cli` includes `planCompleted`, so it is stricter than the 2026-11-12 rows.

| Date | Label | Config | Qualified agents | Pass | Status agrees | Escalated | Cost |
|---|---|---|---|---|---|---|---|
| 2026-11-13 | s8-claude | `configs/lead-claude` | sonnet | 15/15 (100%) | 15/15 | 0 | $1.68 |
| 2026-11-13 | s8-glm | `configs/lead-glm` | glm-5-3-flash | 15/15 (100%) | 15/15 | 0 | $0.28 |
| 2026-11-13 | s8-chain-aif | `configs/lead-chain-aif` | glm-5-3-flash, sonnet (qwen3.5:4b and AI Factory qwen3-8-27b failed the agent suite) | 15/15 (100%) | 15/15 | 0 | $0.38 |

`lead-chain-local` was not run: qwen3.5:4b fails the agent suite, which leaves sonnet alone, the same as `lead-claude`.

Agent qualification of the local Ollama models (same day, `setup.qualify`): none passed.

| Model | Agent suite | Function suite |
|---|---|---|
| qwen3.5:4b | fail: wrote the `1: ` line-number prefixes into the file (another run: repeated failing `EditFile`) | fail |
| qwen3.5:9b | fail: window probe, code word not echoed | pass |
| qwen2.5-coder:7b | fail: file not edited | fail |
| qwen2.5-coder:14b | fail: file not edited | fail |
| gemma4:e4b | fail: file not edited | fail |
| gemma4:12b | fail: wrote line-number prefixes | pass |
| ornith-1.5:9b | fail: window probe (run with the first, oversized 43k-token probe; not re-run with the 28k one) | fail |
| north-mini-code-1.0 | fail: wrote line-number prefixes | fail |

So no escalation happened in these runs: every task finished on the first qualified agent. Escalation is covered by unit tests only.

## External eval: SWE-bench Verified

`packages/evals/src/swebench/` runs the lead against real SWE-bench Verified instances in their official Docker images. Dataset: HF `SWE-bench/SWE-bench_Verified` exported to JSONL (each row carries `image`, `eval_script`, `log_parser`); the older `princeton-nlp` export lacks `eval_script` and is refused by the loader. No download in code — pass the file with `--dataset`.

```
node dist/swebench/main.js --dataset <jsonl> --label <name> [--gold|--no-patch] [--config dir]
  [--only id,id|all] [--parallel n] [--timeout-min 30] [--test-timeout-min 30]
  [--keep never|failed|always] [--rmi] [--skip-qualify]
```

Per instance: pull the official image named in the row → `docker cp /testbed` to a temp workspace → baseline commit → lead run on the host with the problem statement → `git diff` vs baseline excluding `.stewart`/`.claude` → fresh container: apply the patch, run the row's official `eval_script` verbatim, parse the output with the TS port of the row's `log_parser`, grade as upstream (truncated-id prefix match, exit-code guard). Statuses: `resolved` / `unresolved` / `error` (harness fault, reported separately — upstream counts these unresolved). Outputs: `results/<date>-swebench-<label>.json` per instance, `<same>.predictions.jsonl` usable with the official Python harness for cross-check, raw logs in `results/swebench-logs/<label>/`.

Fixed 20-instance subset (`SUBSET_20` in `src/swebench/instances.ts`): django ×9 (11119, 11740, 12663, 13346, 13933, 14580, 15280, 15973, 16661), sympy ×3 (13757, 17655, 22714), sphinx ×2 (8120, 9673), matplotlib 24570, scikit-learn 14053, astropy 13579, xarray 4695, pytest 7324, pylint 6528.

Validation (2026-11-16, labels `val-none-*` / `val-gold-*`): every `--no-patch` run unresolved, every `--gold` run resolved, no error rows — 20/20 and 0/20. No F2P passed at baseline in any no-patch row. Smoke run (real lead): `smoke-claude`, `configs/lead-claude`, `django__django-11119` resolved, f2p 1/1, p2p 7/7, 97 s, $0.0478. Full subset run (2026-11-17, `lead-claude-20`, `configs/lead-claude`): resolved 18/20 (90%), unresolved 2 (`django__django-12663`, `django__django-15280`), harness errors 0, cost $1.4383; results `results/2026-11-17-swebench-lead-claude-20.json`.

Deviation from the notes: log parsing instead of a per-id test resolver — 167 of 231 django instances have docstring ids that cannot be turned into a test label, so each row's `eval_script` runs verbatim and the row's `log_parser` port does the resolution. Known gaps: the lead works on a host checkout and cannot run the repo's tests (the prompt says so); images are ~4 GB each (use `--rmi`); amd64 only; scoring not yet cross-checked against the official Python harness.

## Harness efficiency measurements

`node scripts/analyze-debug-log.mjs <debug-log> [--gap s] [--json]` (tests: `scripts/analyze-debug-log.test.mjs`) reports per run: requests, wall/model time, reasoning share of completion tokens, compactions (count, time, share), requests over the 32k window, repeat file reads. Runs split on a pause (default 900 s, `--gap`); approval waits make this approximate, so compare like with like (same task, same gap). Plan: `docs/HARNESS_EFFICIENCY_PLAN.md`; every step reports before/after with this script.

Baseline, `2026-11-25.log` (AIF `qwen3-8-27b`, 32k window, `effort: medium`), before any harness-efficiency step:

| Run | Requests | Model time | Reasoning share | Compactions | Max prompt | Over 32k | Repeat reads |
|---|---|---|---|---|---|---|---|
| 1 | 9 | 37 s | 51% | 1 (17 s) | 25.8k | 0 | 0 |
| 2 | 49 | 642 s | 81% | 7 (133 s, 21%) | 49.5k | 19 | 36 |
| 3 | 53 | 309 s | 76% | 3 (46 s, 15%) | 29.1k | 0 | 21 |
| 4 (longest continuous session; contains the investigation's run-7, 660 requests / 6607 s, plus neighbouring runs merged by the gap rule) | 798 | 7524 s | 82% | 63 (1189 s, 16%) | 55.6k | 240 | 325 |

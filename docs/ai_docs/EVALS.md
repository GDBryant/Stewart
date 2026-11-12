# Evals

Outcome eval suite (`docs/NEW_DESIGN_2026-11-12.md` §6 step 0). Each build step ends with a run and its pass rate recorded here.

## Suite

- Package: `packages/evals` (`@stewart/evals`). Fixture repo `fixture/base` + `fixture/last-commit` (second commit adds `truncate`); one planted failing test (`range.js` off-by-one) and one planted bug (`cart.js` discount applied twice).
- 15 tasks in `src/tasks.ts`, scored by code (`src/kit.ts`): 5 question, 7 edit (incl. a two-turn follow-up), 2 report, 1 three-milestone build. Every task has a reference solution that passes and a negative that fails (`test/tasks.test.ts`).
- Runner: real `Core` per task over a temp git repo with a Node `HostPort` (`src/nodeHost.ts`); approvals auto-granted once, questions answered with the first option. Pass = the task check; `statusAgrees` = run status `done` iff the check passed.
- Secrets: `STEWART_SECRET_<REF>` env vars (e.g. `STEWART_SECRET_CHANNEL_AI_FACTORY`), also read from gitignored `packages/evals/.env`.

## Run

```
pnpm -r build
cd packages/evals
node dist/main.js --label <name> [--config <dir>] [--disable-lead] [--only id,id] [--parallel n] [--keep never|failed|always]
```

`--config` defaults to `~/.config/stewart` (copied per task). Shipped eval configs: `configs/lead-glm` (native-loop, AI Factory glm-5-3-flash), `configs/lead-claude` (claude-code, sonnet). Results: `packages/evals/results/<date>-<label>.json`; failed task workspaces are kept under `/tmp/stewart-eval-*`.

## Results

| Date | Step | Label | Config | Pass | Status agrees | Cost | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-12 | 0 | baseline | user config, `--disable-lead` (orchestrator path) | 11/15 (73.3%) | 8/15 | $0 | AI Factory returned HTTP 500 on every chat request during the run, so roles bound to it failed. 3 passes ended `no_dispatch`; 2 ended `timeout`; fails: diff summary, rename (broke `strings.js`), function+test (no test), todo CLI |
| 2026-11-12 | 2 | step2-claude-sonnet | `configs/lead-claude` | 15/15 (100%) | 15/15 | $1.65 | lead path, claude-code engine |
| 2026-11-12 | 1 | step1-glm | `configs/lead-glm` | not run | — | — | blocked: AI Factory `/chat/completions` → HTTP 500 (`/models` works) |
| 2026-11-12 | 6 | v3-cutover-claude | `configs/lead-claude` | 15/15 (100%) | 15/15 | $1.65 | after deleting the v2 run path |

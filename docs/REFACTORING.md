# Refactoring for Healthy Code (draft)

Distilled from the orchestrator / dispatch / tool-loop / webview-state refactors. Basic proven points only — grow this doc as the skill learns more.

## Finding targets

Rank candidates by risk-adjusted value, not line count:

- Many mutable variables captured by nested closures — highest bug risk, refactor first.
- Long functions doing several jobs in sequence (route → stream → parse → execute).
- Duplicated tails: same result-finalization copy-pasted in two branches.
- Flat switch/if-chains mixing routing with business logic.
- Skip code that is long but linear and already decomposed.

## Strategies

- **Closure-heavy function → class.** Captured variables become fields; each closure becomes a named method. `runOrchestrated` → `OrchestratedRun`.
- **Giant switch → thin dispatch + named handlers.** One-line-per-case switch, `handleXxx` methods hold the bodies verbatim. `Core.dispatch`.
- **Multi-stage loop → named stage methods.** Each stage returns a small result object (`streamTurn` → `StreamOutcome`, `executeCalls` → `{executed, terminal}`). The loop reads as a recipe. `ToolLoop.run`.
- **Shared finalization.** When two paths end with the same record/emit/update tail, extract it once; differ only via explicit parameters. `applyTaskResult`.
- **Repeated patch patterns → helper.** `tasks.map(t => t.id === x ? {...t} : t)` ×4 → `patchTask(id, update)`; `find + mutate + notify` ×5 → `mutateAssistant`.
- **Split by family.** Group message/event cases by prefix (`task.*`, `plan.*`, `cost.*`) into `onXxxEvent` methods; keep a flat dispatcher.

## Constraints

- **Behavior identical.** Move bodies verbatim; only structure changes. No opportunistic fixes.
- Preserve ordering, side effects, error paths, and partial-state recovery (e.g. accumulated text must survive a mid-stream cancel — keep it in a mutable holder the catch can see).
- Hoist duplicated cleanup only when provably equivalent in all branches.
- Existing tests must pass unmodified; they bracket the refactor.
- Verify: typecheck the package, run its tests, review the diff.
- One refactor per commit. Check `git status` for pre-staged files before committing — stage explicitly by path.

# Plan: split `modules/engines/src/nativeLoop.ts` into purpose-named files

Status: built 2026-11-26 (as-built deviations: `modelEvent` also moved to `nativeModel.ts`; `isParallel`, `executeBatch`, `readGuards`, `Seen` exported from `nativeToolExec.ts`, `dropCalls` from `nativeBudget.ts`; sizes 164/155/31/107 lines; all gates green). Planned 2026-11-26 (revised: all symbol lists verified against the 448-line file; move lists corrected, `readGuards` decision settled as option A). Target: `nativeLoop.ts` (448 lines, largest in repo, over the 300-line soft limit) → 4 files, each with one purpose. Matches the module's existing idiom — every concern that matured has been extracted already (`modelRetry.ts`, `readGuard.ts`, `outputCap.ts`, `exploreGuard.ts`, `reasoningPolicy.ts`, …). Public surface (`api.ts` → `nativeLoop`), behavior, and event ordering stay unchanged; all files land under the 300-line soft limit.

## File layout

| New file | Purpose | Moved from `nativeLoop.ts` (line refs = pre-split) |
| --- | --- | --- |
| `src/nativeModel.ts` (~170) | Model side of a turn: request, stream, retry, record assistant message | `ModelOut` (:30)/`freshOut` (:45), `Mode` (:48) + `RETRY_MIN_CTX` (:52), `hasOutput`, `cutOffEmpty`, `modelEvent` (:122), `retryOpts` (:67), `streamModel` (:73), `streamCut` (:84), `noteReasoning` (:117), `requestModel` (:140), `failure` (:160), `modelTurn` (:169) — all exported except the `ModelOut`/`Mode` types, `freshOut`, `hasOutput`, `cutOffEmpty`, `streamCut`, `noteReasoning` helpers. `RETRY_DELAYS_MS` is *imported* here from `modelRetry.ts`, not owned. |
| `src/nativeToolExec.ts` (~180) | Tool execution: validate → preview → approve → execute, sequential/parallel batches; owns the per-run `ReadGuard` lookup | `TOOL_TIMEOUT_MS` (:24), `readGuards` WeakMap (:27) **moved as-is** (see below), `WRITE_TOOLS` (:28), `summaryOf` (:61) + `SUMMARY_CAP` (:25), `Prepared` (:240), `prepare` (:248), `previewOf` (:193), `execWithTimeout` (:202), `invoke` (:218), `writeRecord` (:234), `executeCall` (:257), `isParallel` (:277), `executeBatch` (:282), `pump` (:312) + `PumpCtx`, `Seen` (:18, exported — `runBatches` still constructs and reads it). |
| `src/nativeBudget.ts` (~35) | Turn budget: nudge + report-only last turn | `NUDGE_LEFT`, `BUDGET_MIN`, `EMPTY_REPORT`, `budgetTurn` (exported — imported by `test/nativeLoop.test.ts:10`, tested at :558–559), `dropCalls` (:347). |
| `src/nativeLoop.ts` (~120, stays) | Orchestration only: the model↔tool turn loop | `run` (:359), `Guards`/`newGuards` (:401–410), `runBatches` (:412), `collectWarnings` (:432), `measuredOf` (:355), the `nativeLoop` engine object (:448) and `api.ts` import (unchanged). New imports added here: `ReadGuard` from `readGuard.js` (constructs the per-run instance), `errorMessage` from `@stewart/kernel` (see below). `measuredOf` type-imports `ModelOut` from `nativeModel.ts` (type-only, no runtime edge). |

Dependency direction (acyclic): `nativeLoop.ts` → {`nativeModel`, `nativeToolExec`, `nativeBudget`} → (kernel/config/channels/permissions/tools + existing siblings). No new file imports another new file except `nativeLoop.ts` does; no new package dependencies for any file.

## `readGuards` — option A: move, don't thread (decision)

The module-global `readGuards: WeakMap<EngineTurn, ReadGuard>` (:27) exists because `invoke` (execution layer) needs the `ReadGuard` instance that `run` (orchestration) creates, and `check:functions` caps params at 4 with an empty baseline — both `executeCall` (:257) and `invoke` (:218) are already at 4 params, so **threading a 5th would fail the gate that is also this split's own check**.

Decision: **move the WeakMap unchanged into `nativeToolExec.ts`.** `run` keeps constructing the `ReadGuard`, setting the map entry and updating `reads.turn` each iteration (:364–372); `invoke` keeps `readGuards.get(turn)?.check(...)` (:226). Zero signature changes, zero behavior risk, split ships clean.

Follow-up (explicitly out of scope): thread the `ReadGuard` properly — e.g. a 3-param `executeCall(turn, call, ctx)` with `ctx = { transcript, seen?, reads }` — so the last stateful global in the module goes away. Do not mix it into this split.

## `err` → kernel `errorMessage` (decision)

Local `err` (:57) is byte-for-byte the `errorMessage` already exported by `@stewart/kernel` (`modules/kernel/src/errorMessage.ts:2`, re-exported from `modules/kernel/src/api.ts:21`) — a pattern duplicated in 5+ files across the repo. As part of the split, delete local `err` and import `errorMessage` at the three call sites: `requestModel` (:148) and `failure` (:162) → `nativeModel.ts`; `invoke`'s catch (:230) → `nativeToolExec.ts`. `@stewart/kernel` is already a dependency of `engines` (line 1), so no new dependency. Behavior identical (same expression).

## Out of scope

- `measuredOf` (usage measurement): stays with `run` — it pairs with the `beforeModelTurn` handoff; it will type-import `ModelOut` from `nativeModel.ts`.
- `runBatches` (batch grouping): stays with `run` — it is the loop's body; moving it would put `executeBatch`'s caller in one file and the callee's siblings in another.
- `readGuards` threading (see above): separate follow-up.
- No rename of `nativeLoop`/`native-loop` id, no `api.ts` change.

## Milestones

0. **Baseline capture.** `pnpm check:functions --report` and `pnpm check:boundaries` before any move; the baseline file (`scripts/functions.baseline.json`) is `{}` and boundary limits are file-level (>300 warns, >500 fails), so pure moves cannot regress them — any new offender after a milestone is real and must be fixed in that milestone.
1. **Extract model side → `src/nativeModel.ts`.** Move the model-request layer (all symbols in the table row) with `nativeLoop.ts` importing `modelTurn` (+ nothing else runtime). Swap the two `err` call sites for `errorMessage`.
    - Check: `cd modules/engines && tsc --noEmit && vitest run` (module typecheck + full module tests, incl. 693-line `nativeLoop.test.ts`).
2. **Extract tool execution → `src/nativeToolExec.ts`.** Move the execution layer + the `readGuards` WeakMap as-is; `run`/`runBatches` call sites unchanged. Swap `invoke`'s `err` call site for `errorMessage`.
    - Check: same module typecheck + tests, then root `pnpm check:boundaries && pnpm check:functions` (catches size drift and any accidental signature regression early, not at milestone 4).
3. **Extract turn budget → `src/nativeBudget.ts`.** Move `budgetTurn`/`dropCalls`/consts; update `test/nativeLoop.test.ts:10` import.
    - Check: same module typecheck + tests + `pnpm check:boundaries`.
4. **Docs + full verification (hard rule: docs same change).** `docs/ai_docs/ARCHITECTURE_NOW.md` — verified complete list of `nativeLoop` references (6 total, lines 52, 67, 85, 93, 97, 131); three need edits: module-table `engines` row (:52) — note the four-file split; the §3 `native-loop` line (:85) — `engines/nativeLoop.ts` → describe the four-file structure (`nativeModel` / `nativeToolExec` / `nativeBudget` / `nativeLoop` orchestration); §3j F1 (:131) — `nativeLoop.requestModel` → `nativeModel.requestModel`. The other three (:67, :93, :97) name the engine, not the file — unchanged. (There is no `nativeLoop.ts invoke` cite in the doc — an earlier draft of this plan claimed one; it does not exist.) `modules/engines/README.md`: surface stays `src/api.ts` (unchanged); purpose line may note the split. `docs/MID_RUN_GUIDANCE_PLAN.md` cites `nativeLoop.ts` by line number (`:305` at its line 19, `:306` at line 104) — stale after the split but it is a proposed-plan doc, not as-built; leave it.
    - Check (root): `pnpm check:docs && pnpm check:boundaries && pnpm check:functions && pnpm check:cycles && pnpm check:layers && pnpm -r typecheck && pnpm -r test`.

## Risk notes

- `run`/`runBatches`/`modelTurn` are all `AsyncGenerator`s chained via `yield*` — moving bodies across files changes nothing to generator semantics; only imports move.
- `check:cycles` (dependency-cruiser) is the tripwire for accidental cross-imports; `check:layers` for a new public-surface mistake.
- Tests exercise behavior through `nativeLoop.run(...)` (all 12 test files in the module), so a silent behavior change in event ordering would surface.
- The only non-pure edit is the `err` → `errorMessage` swap (3 call sites); everything else is a move. If the swap is unwanted, it can be reverted independently — the rest of the plan does not depend on it.

# Complexity refactor plan (health report item 1)

Source: `docs/health_reports/2026-11-08-code-health.md` — "High complexity" 5.5/10 (32 TS/TSX functions >10 branches, 20 >15).

Branch counts below come from a TypeScript-AST scan (`scripts/complexity-scan.mjs`) counting `if`/`switch`/`case`/ternary/loops/`catch`/`&&`/`||`/`??` per function. **Methodology differs from the report**: the report's heuristic yields 32 functions >10 / 20 >15; this scan yields ~79 >10 / ~38 >15. Use the scan for relative ranking and before/after deltas, not absolute parity with the report.

## Top offenders (pre-refactor snapshot)

| Branches | Location | Function |
|---:|---|---|
| 129 | `packages/webview/src/SetupWizard.tsx:54` | `SetupWizard` |
| 65 | `modules/setup/src/recommend.ts:62` | `recommendAssignments` |
| 46 | `modules/orchestration/src/roleRunner.ts:34` | `runRoleTask` |
| 44 | `modules/config/src/v1import.ts:103` | `importV1Xml` |
| 37 | `packages/webview/src/App.tsx:43` | `ChatView` |
| 37 | `packages/webview/src/SettingsView.tsx:291` | `SettingsView` |
| 36 | `modules/setup/src/assign.ts:115` | `score` |
| 35 | `modules/channels/src/{openai,ollama,claude/adapter}.ts` | `chat` ×3 |
| 35 | `hosts/vscode/src/extension.ts:116` | `route` |
| 33 | `modules/agent-loop/src/toolLoop.ts:59` | `run` |
| 32 | `modules/recovery/src/recover.ts:14` | `runTaskRecoverable` |
| 32 | `packages/core/src/handlers/setup.ts:146` | `handleSetupRecommend` |
| 31 | `modules/runs/src/resume.ts:26` | `resumeStrategy` |
| 31 | `packages/webview/src/state.ts:423` | `onEvent`/`onReply` |

## Approach per cluster

### 1. Channel adapters — shared stream decoder
`openai.ts`, `ollama.ts`, `claude/adapter.ts` `chat()` share a skeleton: map messages → wire format → POST/spawn → iterate stream → accumulate text/reasoning/tool_calls/usage → yield `done`.

- Extract `toWireMessages()` per adapter (wire formats differ — keep local).
- Add a `StreamAccumulator` in `modules/channels/src/stream.ts`: owns partial tool-call merge, usage, truncated, and final `tool_calls`/`done` emission. Each adapter decodes one wire line into normalized deltas.
- Claude's process-lifecycle flow differs; extract smaller helpers (`mapNativeCalls`, exit classification) rather than forcing the accumulator.

### 2. `assign.ts` `score()` — dimension scorers
Split into `sizeScore`, `capabilityScore`, `contextScore`, `localityScore`, `perfScore`, `costScore`, `hardwareWarnings`; each returns `{ delta, why[], warnings[] }`; `score()` reduces in the original order (why/warnings order is observable via `reason`).

### 3. `recommend.ts` `recommendAssignments` — pipeline stages
- `discoverChannels()` — channel model discovery loop
- `buildCandidates()` — candidate construction + eligible filter + price enrichment
- `pickResearcher()` — evaluator selection
- `buildRecommendPrompt()` — roleLines/chanLines/ctxLines/prompt
- `parseAndValidate()` — JSON extraction + per-assignment validation

### 4. `roleRunner.ts` `runRoleTask` — extract resolution and result mapping
- `resolveAgent()` — agent/fallback/unhealthy-channel/cost-limit block → `{ agent, channel }` or `TaskResult` refusal
- `buildSessionDeps()` — registry, leasedTools, hooks, budget/meter wiring
- `toTaskResult()` — `LoopResult` → `TaskResult` mapping + error classification

### 5. `v1import.ts` `importV1Xml` — split per v1 section
`importChannels()`, `importAgents()` (mkAgent/roleMap), `importOllamaNumCtx()`, `importVisionOverrides()`, `importSettings()`; shared `V1Ctx` carries warnings/channels/agents/roles/aifBase.

### 6. `recover.ts` `runTaskRecoverable` — fault-handler table
Extract `layer0Retry()`, `askContinue()`, `trySplit()`; loop becomes a dispatcher. Preserve retry/continuation counters exactly.

### 7. `toolLoop.ts` `run()` — turn preparation and outcome handling
- `prepareTurn()` — prune/summarize/compact checks
- `handleStreamOutcome()` — truncation-retry/failed/incomplete/parse-feedback decision tree → discriminated `TurnDecision`

### 8. `resume.ts` — journal loading and per-task replay
- `loadPersistedRun()` — hasJournal/JSON.parse/validation in `plan()`
- `replayTask()` — per-interrupted-task body of `execute()` incl. direct-vs-recovery dispatch

### 9. Webview — component/hook extraction
- `SetupWizard.tsx`: six `step === N` blocks → per-step components; derived state → `useWizardDerived()`; `apply()` agent loop → `buildAgentsForRoles()`
- `state.ts`: `onReply` if-chain → `Record<replyType, handler>` map; extend `onEvent` delegation pattern
- `SettingsView.tsx`/`App.tsx`: `ItemCard` field-kind chain → `FIELD_CONTROLS` map; `ChatView` → `MessageItem`/`Composer`/`ApprovalCard`

### 10. `extension.ts` `route` — route table
`Record<string, handler>`; collapse `setup.session.*`/`setup.probe.*`/`setup.review` groups via `dispatchAndReply()` helper.

## Phasing

- **Phase 0 — measurement: DONE 2026-11-09**: `scripts/complexity-scan.mjs` is a non-blocking report (run with `node scripts/complexity-scan.mjs`).
- **Phase 1 — pure, low-risk**: `assign.ts score()`, `v1import.ts`, channel stream accumulator. Existing unit tests cover these. **DONE 2026-11-09** — see status below.
- **Phase 2 — orchestration core: DONE 2026-11-09**: `recommend.ts`, `roleRunner.ts`, `recover.ts`, `resume.ts`, `toolLoop.ts`, `handleSetupRecommend`. No behavior changes; see status below.
- **Phase 3 — UI/host: DONE 2026-11-09**: SetupWizard split, `state.ts` handler maps, VS Code route table, SettingsView/App extraction. No intended behavior changes; see status below.
- **Phase 4 — DONE 2026-11-09** (all 10 items): `shell.ts` `ShellScanner`, `toolLoop.ts` `executeCall`/`streamTurn` splits, `direct.ts` `DirectState`+`startRun`/`runTask`/`finishRun`, `bench.ts` `BENCH_STEPS`+`summarizePerf`, `orchestrator.ts` `run`/`answerNestedAskUser` splits, `shimParser.ts` JSON/tag helpers, `SettingsView` `RoleCard`/`AgentExtra` field components, `claude/parser.ts` block-kind maps, `plan.ts` arg-validator table, `loader.ts` `loadLayerFile`+`mergeSettingsLayers`; `hosts/vscode` coverage wired. No behavior changes; see status below.

## Phase 1 status (2026-11-09)

- `assign.ts score()` → dimension scorers (`sizeScore`/`capabilityScore`/`contextScore`/`localityScore`/`perfScore`/`costScore`/`hardwareWarnings`); `score()` composes in original order. Scan: 36 → <9.
- `v1import.ts importV1Xml()` → `importChannels`/`importAgents`/`importOllamaNumCtx`/`importVisionOverrides`/`importSettings` over shared `V1Ctx`. Scan: 44 → <9.
- Channels: added `StreamAccumulator` + `postForStream` + per-adapter wire decoders (`openAiDeltas`, `ollamaDeltas`) in `stream.ts`; `openai.ts`/`ollama.ts` `chat()` use them. OpenAI chat 35 → <9; ollama chat ~40 → 12.
- `claude/adapter.ts chat()`: extracted `toToolCalls`, `consumeStdout` (async generator), `finishChat`. 35 → 12.
- Added `modules/channels/test/stream.test.ts` (10 tests) for `StreamAccumulator`/`postForStream`.
- Scan totals: >15 branches 43 → 38; >10 branches 81 → 79. All module tests green (channels 89, setup 70, config 20); typecheck clean.

## Phase 2 status (2026-11-09)

- `recommend.ts recommendAssignments()` → `discoverChannels`/`buildCandidates`/`pickResearcher`/`buildRecommendPrompt`/`parseAndValidate` plus `formatContextBlock`/`validateAssignment`. Scan: caller <9; `parseAndValidate` <9, `buildRecommendPrompt` 9, `validateAssignment` 11.
- `roleRunner.ts runRoleTask()` → `resolveAgent`/`buildSessionDeps`/`toTaskResult`. Scan: 46 → 12.
- `recover.ts runTaskRecoverable()` → `layer0Retry`/`askContinue`/`trySplit` over shared `RetryState`; retry/continuation/question counters unchanged. Scan: 32 → 12.
- `resume.ts resumeStrategy()` → `loadPersistedRun`/`replayTask` plus `planResume`/`executeResume`/`confirmInterrupted`/`markInterrupted` over `ResumeState`. Scan: 20 → <9; `planResume` 14.
- `toolLoop.ts run()` → `prepareTurn`/`handleStreamOutcome`/`finishTurn`. Scan: 33 → 10.
- `handlers/setup.ts handleSetupRecommend()` → `benchCandidates`/`persistSetupPreferences`/`buildRecommendContext`/`recommendSelection` (`SetupRecommendParams`). Scan: 32 → <9.

## Phase 3 status (2026-11-09)

- `SetupWizard` → six step components in `SetupWizardSteps.tsx`/`SetupWizardResult.tsx`, derived lists and parent-lifetime hooks in `wizardDerived.ts`, pure `buildAgentsForRoles` in `wizardApply.ts`, constants/pure helpers in `wizardShared.ts`. Scan: 129 → 10; `useWizardDerived` 12, `DiscoverStep` 9. Channel/evaluator inputs and probe deduplication survive back-navigation.
- `state.ts` → typed, per-instance reply/event handler maps with own-property dispatch and existing task/plan/cost delegates. Scan: `onReply` 19 → <9; `onEvent` 31 → <9.
- `App.tsx` → `MessageItem`/`ApprovalCard`/`Composer`, with composer-owned draft/image insertion and chat-owned autoscroll. Scan: `ChatView` 37 → 9; `Composer` 13.
- `SettingsView.tsx` → `FIELD_CONTROLS` and keyed `TAB_VIEWS` rendering, preserving tab unmount/form-reset behavior; enabled-channel testing stays in an unconditional hook. Scan: `SettingsView` 37 → 13; `ItemCard` 26 → 14.
- VS Code routing → `routes.ts` route table and `dispatchAndReply`; `extension.ts` retains activation and serialized routing. Scan: `route` 35 → <9. Supported setup groups, dispatch payloads, reply ordering, errors and unknown-method forwarding remain unchanged.
- Verification: webview 92 tests, VS Code routes 33 tests; both packages typecheck/build clean. Webview coverage: 96.35% lines / 87.59% branches (90/80 thresholds unchanged). Layers, boundaries, cycles and TS references pass. UI exercised through jsdom; live IDE/browser smoke not run.

## Phase 4 status — items 1–5 (2026-11-09)

- `permissions/shell.ts` `splitShellPrograms` 30 → 9 via `ShellScanner` with per-state handlers (`inPlain`/`inSingle`/`inDouble`; `inPlain` 14). New `test/shell.test.ts` characterization added before the refactor: quotes/escapes, `;&|` plus `&&`/`||`/newline, `$()`/backticks, unterminated quotes, empty/assignment-only input.
- `agent-loop/toolLoop.ts` `executeCall` 29 → `resolveTool`/`gateCall`/`invokeTool`/`shapeResult` (max 12); `streamTurn` 26 → 9 via `streamDeltas` onDelta handler map + `armCallTimeout`. +4 edge tests: reasoning event, non-Error tool throw, null approval preview, pre-aborted gate.
- `runs/direct.ts` `execute` 28 → `DirectState` + `startRun`/`runTask`/`finishRun` + `wantsContinue`/`askContinue` (all ≤10), mirroring `resume.ts`. +6 tests: model failure, turn-limit without recovery, Stop answer, free-text continue guidance, `cost.summary`, time-cap interrupt.
- `setup/bench.ts` `benchModel` 27 → `BENCH_STEPS` per-leg table (`speed`/`tools`/`edit`/`json`) + `summarizePerf`. +3 tests: chars/4 token fallback, isolated json-leg failure, unparseable braces.
- `orchestration/orchestrator.ts` `run` 24 → `buildSession`/`runSession`/`finalize`; `answerNestedAskUser` 18 → `selfAnswer` + `askOrchestrator` ChatEvent-kind handler map. +5 tests: self-answer throw/ask_user-delegation/empty fallbacks, withdrawn prompt, layer-0 incomplete_stream retry.
- `hosts/vscode`: `@vitest/coverage-v8@3.2.4` devDep + `test:coverage` script + `vitest.config.ts` (v8 provider, 90/80 thresholds; `extension.ts`/`host.ts` excluded as vscode-API-bound). routes.ts 100% lines / 97.36% branches.
- Verification: vitest + `tsc --noEmit` clean per package (permissions 31, agent-loop 65, runs 63, setup 77, orchestration 90, vscode 33 tests). Coverage ≥90/80 everywhere touched. `check:layers`/`check:boundaries`/`check:cycles`/`check:tsrefs` pass.
- Scan checkpoint: >10 branches 72 → 68; >15 branches 22 → 15. Every Phase-4 target and helper is <15 (`runSession` exactly 15). The ≤12 target is not reached — the remainder is items 6–10 scope.

## Phase 4 status — items 6–10 (2026-11-09)

- `toolcall-format/shimParser.ts` `firstJsonValueEnd` 23 → `jsonStringEnd`/`jsonCompositeEnd` (14); `tagAt` 19 → 10 via `tagBounds`/`tagRaw`/`parseTagCall`. +4 characterization tests (brackets/escapes inside JSON strings, raw attr values, unterminated string, scalar tail). Sidecar re-bundled (`tsc`+`esbuild`, 768.7kb, clean).
- `webview/SettingsView.tsx` `RoleCard` 23 → `RoleEditForm` + `RoleAgentField`/`CsvField`/`ToolPicker`/`TurnBudgetField`/`SkillTicks`; `AgentExtra` 21 → `AgentBadges`/`ProbeStatus`. +2 jsdom tests: skill toggle on/off (incl. re-inbound state), turnBudget unlimited/number/blank.
- `channels/claude/parser.ts` `assistantEvent` 22 → 9 via `toolBlock`/`textBlock` content-block kind handler maps. +1 test: thinking + empty-block skipping for undelta'd assistant messages.
- `recovery/plan.ts` `parseRecoveryArgs` 22 → `SUBTASK_FIELDS` validator table + `parseSubtask` (callback collapsed; plan.ts was already fully covered — no new tests needed).
- `config/loader.ts` `loadConfig` 21 → 9 via `loadLayerFile`/`mergedItems`/`mergeSettingsLayers`/`applyRequiredTools`; roles keep the 3-way field-merge, channels/agents keep concat-then-replace semantics.
- Verification: vitest + `tsc --noEmit` clean per package (toolcall-format 87, webview 94, channels 90, recovery 36, config 20 tests). Coverage ≥90/80 everywhere touched (toolcall-format 94.1/86.2, webview 96.6/87.9, channels 97.1/86.4, recovery 97.6/87.0, config 97.4/88.0). `check:layers`/`check:boundaries`/`check:cycles`/`check:tsrefs` pass. Webview esbuild bundle OK (119.9kb).
- Scan checkpoint: >10 branches 68 → 61; >15 branches 15 → 8. Every Phase-4 target and helper is <15.

## Nesting pass (2026-11-09)

AST nesting scan (`if`/loops/`switch`/`try`/`catch`/ternary depth per function) before → after: functions at depth ≥5: 8 → 0; depth ≥4: 36 → 21; max depth 6 → 4.

- Depth 6→≤3: `consumeStdout` (parser-event dispatch), `globToRegex`/`applyUnifiedPatch` (`GLOB_ATOMS`/`addPatchLine`+`applyHunk`), `repairJson`/`jsonCompositeEnd` (`repairPlain`/`compositePlain`), `expandMentions` (`MENTION_HANDLERS`), `smokeModel` (`probeStepOutcome`/`probeVerdict`), `unflatten` (`coerceField`).
- Depth 5→≤3: same set (three of the eight were depth 5).
- Depth 4→≤3 (8 functions): `lines` (`nextChunk`/`drainBuffer`), `rebuild` (`loadChannelSecret`), `detectStuck` (`collectOutcomes`/`scanAssistantTurn`), `recoveryCall` (`recoveryCallError`), `validateRoles` (`roleAgentErrors`/`roleFallbackErrors`), `history.save`/`load` (`storeImages`/`restoreImages`), `recordUsage` (`usageSource`), `readAttrValue` (`quotedAttrValue`).
- Skipped as risky/recently-refactored: `orchestrator.runSession`, `toolLoop.streamTurn`/`invokeCall`, channel `chat` adapters, `assembleFinalFile`/`splitTask`, `decodeJsonObject`, `fsRead.execute` ×2, setup `sessionDeps`/`approveAndSave`/`measureSpeed`/`discoverChannels`, `snapshots.revertRunSnapshots`, core `handlers/setup`.
- Verification: all touched-package vitest+tsc clean; full `pnpm -r test`/`typecheck`/`build`/`test:coverage` + structural checks re-run (see health report update).

## Verification per phase

`pnpm -r test`, `pnpm -r typecheck`, `pnpm -r build`, `check:layers`/`check:boundaries`/`check:cycles`. Re-run complexity scan; target every function <15 branches. Scan >15 count: 43 → 38 after Phase 1; Phase 2/3 should push toward single digits. No behavior change; helpers stay inside their module.

## Scan checkpoint (2026-11-09)

Snapshot before Phase 2: >10 branches 79, >15 branches 38. After Phase 2: >10 branches 78, >15 branches 31. After Phase 3: >10 branches 72, >15 branches 22. After Phase 4 items 1–5: >10 branches 68, >15 branches 15. After Phase 4 items 6–10: >10 branches 61, >15 branches 8. All Phase-3 target functions and their new helpers are below 15; untouched hotspots remain, including `RoleCard` (23) and `AgentExtra` (21). The repository-wide every-function-<15 and single-digit >15 goals are not yet achieved.

## Gap audit (2026-11-09, post Phase 3)

Full gate run: 30 packages tests + typecheck green (1023 tests), layers/boundaries/cycles/tsrefs pass. One gap found and fixed:

- `packages/core` coverage was 78.96% lines (threshold 90) — `handlers/setup.ts` 49% (session handlers, `benchCandidates`), `setupProbe.ts` 64% (live discovery, evaluator ranking, retry), `types.ts` 0% (type-only). Added `test/setupSession.test.ts`, `test/recommendBench.test.ts`, `test/probeDiscovery.test.ts`, one `chat.send` orchestrator case; excluded `handlers/types.ts` from coverage. Now 98.47% lines / 89% branches, 92 tests.
- `hosts/vscode` has no coverage config (`@vitest/coverage-v8` not a dep) — not a regression, noted for Phase 4.

## Phase 4 — complete (all 10 items done 2026-11-09)

All ranked items below were implemented; see the Phase 4 status sections for per-item detail.

| # | Branches | Location | Function | Approach |
|---:|---:|---|---|---|
| 1 | 30 | `modules/permissions/src/shell.ts:32` | `splitShellPrograms` | Tokenizer state machine → `ShellScanner` with per-char handlers (quote/escape/operator/subshell); keep fixture tests verbatim. Pure, security-adjacent: must bracket with existing negative tests. |
| 2 | 29 | `modules/agent-loop/src/toolLoop.ts:332` | `executeCall` | Split permission check / tool resolve / invoke / result shaping into `resolveTool`, `gateCall`, `invokeTool`, `shapeResult`; pairs with `streamTurn` (26) → extract `onDelta` handler map and `closeOpenToolCalls` already exists. |
| 3 | 28 | `modules/runs/src/direct.ts:47` | `execute` | Mirror `resume.ts`: `DirectState` + `startRun`/`runTask`/`finishRun`; direct = single-task run (aligns with `ARCHITECTURE_REFACTORING.md` R2). |
| 4 | 27 | `modules/setup/src/bench.ts:38` | `benchModel` | `runBenchStep(kind)` table for the prompt/tool/vision legs; `summarizePerf` for scoring. |
| 5 | 24 / 18 | `modules/orchestration/src/orchestrator.ts:115,198` | `run`, `answerNestedAskUser` | `dispatchReady`/`collectResults`/`finalize`; `answerNestedAskUser` → question-kind handler map. |
| 6 | 23 / 19 | `modules/toolcall-format/src/shimParser.ts:596,335` | `firstJsonValueEnd`, `tagAt` | Lower priority: parser hot path with verbatim fixtures; only touch if coverage stays identical. |
| 7 | 23 / 21 | `packages/webview/src/SettingsView.tsx:384,288` | `RoleCard`, `AgentExtra` | Per-field subcomponents reusing `FIELD_CONTROLS`; `RoleCard` tool-picker → `ToolPicker`. |
| 8 | 22 | `modules/channels/src/claude/parser.ts:212` | `assistantEvent` | Content-block kind → handler map (`text`/`thinking`/`tool_use`). |
| 9 | 22 / 14 | `modules/recovery/src/plan.ts:11,17` | `parseRecoveryArgs` | Arg validators table; collapse callback. |
| 10 | 21 | `modules/config/src/loader.ts:62` | `loadConfig` | Per-file `loadLayerFile` + `mergeLayers`. |

Also: add `@vitest/coverage-v8` + `test:coverage` to `hosts/vscode` so CI enforces the 90/80 bar there too.

Target met: >15 count 22 → 8 after all Phase-4 items. Scan checkpoint recorded above.

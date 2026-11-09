# Complexity refactor plan (health report item 1)

Source: `docs/health_reports/2026-11-08-code-health.md` — "High complexity" 5.5/10 (32 TS/TSX functions >10 branches, 20 >15).

Branch counts below come from a TypeScript-AST scan (`temp/complexity-scan.mjs`) counting `if`/`switch`/`case`/ternary/loops/`catch`/`&&`/`||`/`??` per function. **Methodology differs from the report**: the report's heuristic yields 32 functions >10 / 20 >15; this scan yields ~79 >10 / ~38 >15. Use the scan for relative ranking and before/after deltas, not absolute parity with the report.

## Top offenders

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

- **Phase 0 — measurement**: promote `temp/complexity-scan.mjs` into `scripts/` as a report (non-blocking).
- **Phase 1 — pure, low-risk**: `assign.ts score()`, `v1import.ts`, channel stream accumulator. Existing unit tests cover these. **DONE 2026-11-09** — see status below.
- **Phase 2 — orchestration core**: `recommend.ts`, `roleRunner.ts`, `recover.ts`, `resume.ts`, `toolLoop.ts`, `handleSetupRecommend`.
- **Phase 3 — UI/host**: SetupWizard split, `state.ts` handler map, `extension.ts` route table, SettingsView/App extraction.

## Phase 1 status (2026-11-09)

- `assign.ts score()` → dimension scorers (`sizeScore`/`capabilityScore`/`contextScore`/`localityScore`/`perfScore`/`costScore`/`hardwareWarnings`); `score()` composes in original order. Scan: 36 → <9.
- `v1import.ts importV1Xml()` → `importChannels`/`importAgents`/`importOllamaNumCtx`/`importVisionOverrides`/`importSettings` over shared `V1Ctx`. Scan: 44 → <9.
- Channels: added `StreamAccumulator` + `postForStream` + per-adapter wire decoders (`openAiDeltas`, `ollamaDeltas`) in `stream.ts`; `openai.ts`/`ollama.ts` `chat()` use them. OpenAI chat 35 → <9; ollama chat ~40 → 12.
- `claude/adapter.ts chat()`: extracted `toToolCalls`, `consumeStdout` (async generator), `finishChat`. 35 → 12.
- Added `modules/channels/test/stream.test.ts` (10 tests) for `StreamAccumulator`/`postForStream`.
- Scan totals: >15 branches 43 → 38; >10 branches 81 → 79. All module tests green (channels 89, setup 70, config 20); typecheck clean.

## Verification per phase

`pnpm -r test`, `pnpm -r typecheck`, `pnpm -r build`, `check:layers`/`check:boundaries`/`check:cycles`. Re-run complexity scan; target every function <15 branches. Scan >15 count: 43 → 38 after Phase 1; Phase 2/3 should push toward single digits. No behavior change; helpers stay inside their module.

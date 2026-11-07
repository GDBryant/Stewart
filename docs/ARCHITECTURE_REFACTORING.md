# Architecture Refactoring (plan)

Status: **proposed**, 2026-11-07, baseline `57e3da9` (budgets M4). Current state: `docs/ARCHITECTURE_NOW.md`. Refactor rules: `docs/REFACTORING.md` (behavior identical unless stated, one refactor per commit, existing tests bracket each step).

Three refactors. R1 (model profile + agent session) goes first; R2 (one run pipeline) and R3 (integrated context compaction) build on it.

## R1. One model profile, one agent-session builder

### Problem
- `new ToolLoop(...)` is built in 5 places: `runManager.ts` `drive()`, `orchestration/orchestrator.ts`, `orchestration/roleRunner.ts`, `orchestration/recovery.ts`, `bench.ts`. Each derives tools mode (`modelCaps?.[model]?.tools ?? DEFAULT_CAPS.tools`), limits, prompt prefix, listener and cost recording on its own.
- `resolveLimits({role, agent, profile, ceiling, perf: channel.cfg.modelCaps?.[agent.model]?.perf, channelType})` is copy-pasted at 3 call sites.
- Model facts (caps, perf, price, cost tier) are merged in 5 places: `core.ts` (`applyProbes`, probe handler), `recommend.ts` (price precedence), `roles.ts` (`agentCaps`), `limits.ts` (catalog price fallback), `channels/ollama.ts` (`numCtx`). Precedence (user `modelCaps` > probe > bench > catalog/live; `agent.price` wins for cost) is re-implemented each time.
- Planned work multiplies this: budgets M5 (`/quick` `/deep` changes agent strength), code-health role, fallback-agent switching.

### Target
```ts
// packages/core/src/modelProfile.ts
interface ModelProfile {
  channelId: string; channelType: string; model: string;
  caps: ModelCaps;            // merged, user > probe
  toolsMode: ToolsMode;       // caps.tools ?? DEFAULT_CAPS.tools
  perf?: ModelPerf;
  price?: { inPerMTok: number; outPerMTok: number; source: "agent" | "live" | "catalog" };
  costBlended?: number; costTier?: CostTier;
}
function resolveModelProfile(config: Config, ref: { channel: string; model: string; agent?: AgentDef }, live?: PriceMap): ModelProfile;

// packages/core/src/agentSession.ts
interface SessionSpec {
  agent: AgentDef; role?: RoleDef; channel: ManagedChannel;
  registry: ToolRegistry; approve: ApprovalGate;
  prompt?: string; terminal?: Set<string>;
  budget: { profile: BudgetProfile; ceiling: number };
  limitsOverride?: Partial<LoopLimits>;          // orchestrator tool-output cap, bench turns
  meter?: { ledger: RunLedger; runId: string; taskId: string; roleId?: string };
  idem?: IdempotencyHooks;
  events: { bus: EventBus; runId: string; taskId?: string; roleId?: string };
}
function createAgentSession(spec: SessionSpec, clock: Clock): { loop: ToolLoop; listener: LoopListener; profile: ModelProfile; limits: LoopLimits };
```
- `resolveLimits` takes a `ModelProfile` instead of `perf` + `channelType`.
- The listener built by the session emits the standard `text_delta`/`reasoning_delta`/`compaction`/`tool.request`/`tool.outcome` events and records `onUsage` to the ledger when `meter` is set. Call sites add extras (e.g. `filesTouched`, terminal call id) by wrapping it.

### Steps (one commit each)
1. Add `modelProfile.ts` + tests; switch `roles.ts` `agentCaps` and `limits.ts` to it. Behavior identical.
2. Switch `recommend.ts` price precedence and `core.ts` probe merge to it. Behavior identical.
3. Add `agentSession.ts` + tests; migrate `roleRunner.ts`.
4. Migrate `orchestrator.ts` (with `limitsOverride.maxToolOutputChars`), `orchestration/recovery.ts` (layer-1 brain loop) and `bench.ts` (`maxModelTurns: 3`, no meter).
5. Migrate `runManager.drive()` (no meter yet; R2 adds it).

### Tests
- Positive: precedence matrix (user cap beats probe; `agent.price` beats live beats catalog; unknown stays `undefined`, never 0); session emits the same event sequence as today per call site (snapshot existing tests); meter records ledger entry with role/task ids.
- Negative: unknown channel/model returns empty caps with `toolsMode: shim`; session without `meter` writes no ledger entry; `limitsOverride` cannot raise turns above the ceiling.

## R2. One run pipeline: direct = single-task run

### Problem
`RunManager` has two engines (see `ARCHITECTURE_NOW.md` §3):

| | Direct (`drive`) | Orchestrated / resume |
|---|---|---|
| Ledger + cost cap | no | yes |
| Idempotency log | no | yes |
| Journal + `/resume` | no | yes |
| Run time cap | own `capTimer` (M4) | `maxRunHours` check in orchestrator |
| Runtime object | ad hoc locals | `OrchestrationRuntime`, built twice (`resume`, `driveOrchestrated`) |

Every new run-level rule (M4 time cap, M6 escalation, continue question, code-health role) must be written twice. Direct runs on paid agents bypass `costLimit.perRunUsd`.

### Target
- `RunManager.buildRuntime(run, config, opts): Promise<RunRuntime>` is the only place that creates ledger handle, `CostLimit`, `LeaseManager`, `IdempotencyLog`, grants, approve/ask, budget profile and run time cap. Rename `OrchestrationRuntime` → `RunRuntime` (type alias kept for one release).
- Run time cap lives in the runtime (one abort timer on `rt.signal`), not in `drive()` or the orchestrator.
- Direct mode = one `TaskSpec { id: "direct", role: role ?? general-worker, task: text }` run through `runRoleTask` with conversation `history` passed as prior messages. `drive()` is deleted.
- `runRoleTask` gains an optional `history?: ChatMessage[]` and streams task events; the webview treats the direct task as the run's only task (no task row when `tasks.length === 1 && id === "direct"`).
- Result: one place for lifecycle → journal → history → `run.finished`.

### Behavior changes (intended, user-visible)
- Direct runs are metered and stop at the cost cap (park → summary card), and appear in `ledger.jsonl`.
- Direct runs are journaled and resumable via `/resume`.
- Tool calls in direct runs get idempotency keys `runId:direct:callSeq`.

### Steps (one commit each)
1. Extract `buildRuntime`; use it in `resume` and `driveOrchestrated`. Behavior identical.
2. Move run time cap into the runtime; remove the orchestrator check and `drive()` `capTimer`. Behavior identical.
3. Add `history` to `runRoleTask`; route `direct()` through it behind `settings.directViaRuntime` (default `true`, removable after one release). Delete `drive()` once tests pass.
4. Webview: hide the single direct task row; show cost for direct runs.
5. Update `ARCHITECTURE_NOW.md` §3, `docs/FAULT_RECOVERY.md` (resume covers direct), `docs/PROGRESS.md`.

### Tests
- Positive: direct run on a `priced` fake agent records ledger entries and parks at the cap; direct run journal + `/resume` re-dispatches; time cap aborts both modes via one timer; existing direct-run tests (streaming, cancel transcript, turn limit → `stopped`, history save) pass unchanged.
- Negative: `perRunUsd: 0` never parks a direct run; `free` agent direct run never parks; cancelled direct run does not resume as `done`; resumed direct run does not re-execute a recorded tool call.

## R3. Integrated context compaction (prune → summarize inside the loop)

### Problem
- `ToolLoop.compactIfNeeded` (`tools/toolLoop.ts`) is an emergency step: acts only over `maxContextChars`, keeps the last 2 messages, replaces the rest with 120-char snippets, else fails `context_limit`.
- Every turn up to the limit pays for full history; large tool outputs stay in context all run.
- Summary is lossy (drops paths, decisions, errors); nothing is pinned; savings and cost are not metered.

### Target
Compaction is a normal loop stage, built by `createAgentSession` (R1):
```
turn start → MEASURE (green <60% · amber 60–80% · red >80% of ModelProfile ctx)
  → PRUNE   (amber; no LLM): stub stale tool results ("read_file a.ts 4.2k tok → elided, re-read if needed"),
            dedupe re-reads, cap new tool output at ingest
  → SUMMARIZE (red / prune insufficient): pinned | middle | tail
            pinned = task text, plan/todo, grants, last user answer; tail = last K turns, tool_call/result pairs intact
            middle → structured note (goal · done · decisions · files touched · open errors · next step) by a cheap `compactor` agent
  → VERIFY  still over → shrink tail, else fail `context_limit`; never compact inside an open tool call
  → CALL
```
```ts
// packages/core/src/tools/compaction.ts
interface CompactionPolicy { amber: number; red: number; target: number; keepTurns: number; compactor?: AgentDef }
function planCompaction(msgs: ChatMessage[], ctxTokens: number, policy: CompactionPolicy): { prune: number[]; summarize?: Range }
```
- `SessionSpec` gains `compaction?: CompactionPolicy`; thresholds come from `resolveLimits` (`quick` early/hard, `deep` late/keep more) and `ModelProfile` ctx (`numCtx` for Ollama).
- Compact in batches (down to `target` ≈40%) so the prompt prefix stays stable for provider caching; pinned items first.
- Compactor cost goes through `meter` under role `compactor`; `compaction` event gains `{before, after, pruned, summarized}`.
- Full transcript stays in the journal and `scratch/<runId>/`; stubs say how to re-fetch.

### Steps (one commit each)
1. Extract current `compactIfNeeded` into `compaction.ts` (`planCompaction` + apply). Behavior identical, existing tests pass.
2. Add prune stage (stale-result stubs, dedupe, ingest cap) behind `settings.compaction.prune` (default false until bench-compared; summarize step 3 likewise via `settings.compaction.summarize`).
3. Add pinned/tail split and structured summarizer via `compactor` agent (no default role: user-defined `compactor` role, absent = inert); fallback to the emergency clip on summarizer failure.
4. Meter compactor cost; extend `compaction` event; webview shows savings.
5. Update `ARCHITECTURE_NOW.md` (§2 Tools, §3), `docs/FAULT_RECOVERY.md` (`context_limit`), `docs/PROGRESS.md`.

### Tests
- Positive: prune stubs stale output and keeps tool_call/result pairs; pinned items survive summarize; compactor cost lands in ledger; compacted run continues to completion; `quick` compacts earlier than `deep`.
- Negative: green zone never calls summarizer; never splits an in-flight tool call; summarizer failure falls back to prune-only then `context_limit`; no `meter` → no ledger entry; stub never elides the latest read of a path.

### Deviations / not done (R3 as built)
- No `CompactionPolicy`/`planCompaction`: thresholds are `pruneAt/summarizeAt` on `LoopLimits`, set by `resolveLimits` from the budget profile (quick 40/60%, normal 60/80%, deep 75/90%); `maxContextChars` is still the fixed 400k, not derived from `ModelProfile` context.
- No batch compaction down to a ~40% target (provider-cache prefix stability not addressed); re-reads are deduped by `pruneStale` (superseded results stubbed) and tool output is capped at ingest per profile/context (`toolOutputCap`, head+tail).
- Prune and summarize are wired for `roleRunner`/direct runs and the orchestrator loop (`compactionFor`); not for recovery (4-turn `submit_recovery` call) or bench (3-turn probes), which are too short to compact.
- Summarizer needs a user-defined `compactor` role (no default); skipped once the cost cap is reached and the agent is paid.
- Both flags (`compaction.prune`, `compaction.summarize`) stay off until the bench comparison; not yet run.

## Risks
- R2 changes direct-run UX (cost card, journal files). Mitigate with the flag in step 3 and an explicit note in release notes.
- Parallel session work on budgets M5/M6 touches the same call sites. Land R1 steps 1–3 before M5's agent-switching, or rebase M5 onto `createAgentSession`.
- R3 changes model-visible history (stubs, summary note); pin behavior with flag + transcript snapshots, and compare task success on the bench before defaulting prune on.
- R3 needs R1 step 3 (`createAgentSession`) to avoid wiring policy at four call sites.
- Event ordering: the session listener must emit in today's order; pin with snapshot tests before migrating each call site.

## Done when
- `rg "new ToolLoop\(" packages/core/src` → only `agentSession.ts`.
- `rg "resolveLimits\(" packages/core/src` → only `agentSession.ts` (+ tests).
- `rg "OrchestrationRuntime = \{|const rt: RunRuntime = \{" packages/core/src` → only `buildRuntime`.
- `compactIfNeeded` removed from `toolLoop.ts`; compaction lives in `compaction.ts`.
- `drive()` removed; `ARCHITECTURE_NOW.md` §3 table shows one row for all modes.
- `pnpm -r build typecheck test` green; coverage ≥90% line / ≥80% branch.

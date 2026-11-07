# Architecture Refactoring (plan)

Status: **proposed**, 2026-11-07, baseline `57e3da9` (budgets M4). Current state: `docs/ARCHITECTURE_NOW.md`. Refactor rules: `docs/REFACTORING.md` (behavior identical unless stated, one refactor per commit, existing tests bracket each step).

Two refactors. R1 (model profile + agent session) goes first; R2 (one run pipeline) builds on it.

## R1. One model profile, one agent-session builder

### Problem
- `new ToolLoop(...)` is built in 4 places: `runManager.ts` `drive()`, `orchestration/orchestrator.ts`, `orchestration/roleRunner.ts`, `bench.ts`. Each derives tools mode (`modelCaps?.[model]?.tools ?? DEFAULT_CAPS.tools`), limits, prompt prefix, listener and cost recording on its own.
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
4. Migrate `orchestrator.ts` (with `limitsOverride.maxToolOutputChars`) and `bench.ts` (`maxModelTurns: 3`, no meter).
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

## Risks
- R2 changes direct-run UX (cost card, journal files). Mitigate with the flag in step 3 and an explicit note in release notes.
- Parallel session work on budgets M5/M6 touches the same call sites. Land R1 steps 1–3 before M5's agent-switching, or rebase M5 onto `createAgentSession`.
- Event ordering: the session listener must emit in today's order; pin with snapshot tests before migrating each call site.

## Done when
- `rg "new ToolLoop\(" packages/core/src` → only `agentSession.ts`.
- `rg "resolveLimits\(" packages/core/src` → only `agentSession.ts` (+ tests).
- `rg "OrchestrationRuntime = \{|const rt: RunRuntime = \{" packages/core/src` → only `buildRuntime`.
- `drive()` removed; `ARCHITECTURE_NOW.md` §3 table shows one row for all modes.
- `pnpm -r build typecheck test` green; coverage ≥90% line / ≥80% branch.

# Stewart — Modular Design (healthy-code structure)

Status: proposal. Derived from `project_features.md` only, not from the current file layout. Maps to today's code in §7. Complements `ARCHITECTURE_REFACTORING.md` (R1–R3) and scores against the `code-health` rubric.

## 1. Health rules (the design constraints)

Every module and unit must meet these. They are enforced by tooling (§6), not by review.

| Rule | Limit |
|---|---|
| File | ≤ 300 lines, one reason to change |
| Function | ≤ 40 lines, cyclomatic ≤ 10, nesting ≤ 3, ≤ 4 params (else an options object) |
| Module surface | one `api.ts` of types + factory; ≤ ~12 exported members |
| Dependencies | acyclic, layered, downward only |
| Imports | across modules only via `api.ts`; never deep paths |
| State | owned by exactly one module; others see it through queries or events |
| Side effects | only at edges (ports); domain logic is pure and takes `Clock`/`IdGen` |
| Errors | fallible calls return `Result<T, StewartError>`; no thrown control flow across modules. Exceptions, stated once: total discriminated unions that are outcomes, not failures (`Decision`, `LeaseResult`); lookups return `T \| undefined`; infallible commands return `void` and report internal faults to `diagnostics`; streams carry an `error` variant in their event union |
| Suppressions | no `@ts-ignore`, `eslint-disable`, skipped tests |

## 2. Layers

Dependencies point down only. A module may use any module in a strictly lower layer, never one in its own layer or above. Where two modules would need each other, the interface is declared in the lower one (dependency inversion).

```
L9   app          composition root + RPC router + event batching (Core)
L8   runs         run lifecycle (direct / orchestrated / resume strategies), slash-command parsing
L7   agents       orchestration · recovery · setup
L6   loop         agent-loop (also declares the `Recovery` interface and fault types)
L5   tools        tools (uses `context` for image limits)
L4   engine       compaction · context
L2b  domain       roles-skills · channels · budget · ledger · permissions · scheduling · run-state
L2a  domain base  models · interaction
L1   platform     config · catalog · toolcall-format · diagnostics
L0   kernel       Result, errors, ids, Clock, IdGen, EventBus, schema helpers, HostPort types
```

`interaction` is the single owner of user-facing prompts (approvals, `ask_user`, continue question, plan gate, cost-limit card, `withdraw`). `permissions`, `ledger`, `orchestration` and `recovery` all use it instead of building their own.

### Outside core

| Part | Surface | Rule |
|---|---|---|
| `protocol` | JSON-RPC methods, `RunEvent` union, `PROTOCOL_VERSION`, capability flags | Additive only; only contract shared by core, sidecar, hosts and webview |
| `sidecar` | stdio JSON-RPC server → `Core.dispatch`; reverse-RPC → `HostPort` | Transport only, no domain logic |
| `hosts/vscode`, `hosts/jetbrains` | implement `HostPort` (+ supervision for JetBrains); load the webview | Pass the `HostPort` contract suite; no Stewart logic |
| `webview` | state store + `bridge` (protocol only); chat, settings, setup, approvals as separate UI modules | Never imports core; renders `RunEvent`s |

## 3. Modules and their surfaces

Each row: what it owns, the surface others may use, what it depends on. Surfaces are sketched in §4.

| # | Module | Owns (feature) | Surface | Depends on |
|---|---|---|---|---|
| 0 | `kernel` | Result/errors, `Clock`, `IdGen`, `EventBus`, `HostPort` types | types + tiny helpers | — |
| 1a | `config` | YAML load, zod validate, shipped<user<project merge by id, watch, `SelfWriteGuard`, atomic write, v1 import | `ConfigService` | kernel |
| 1b | `catalog` | bundled price/limits/context data, `lookupModelInfo`, `costTier` | `Catalog` (pure) | kernel |
| 1c | `toolcall-format` | shim parser, JSON repair, alias map, stream filter, shim prompt | `parseToolCalls`, `ToolCallStreamFilter`, `shimPrompt` (pure) | kernel |
| 1d | `diagnostics` | debug log sink, redaction, retention | `DebugLog` | kernel |
| 2a | `models` | one merge of caps/probe/bench/catalog/price → `ModelProfile`; declares the `ProbeLoop` contract and `ModelPerf` | `ModelProfiles` (pure), `ProbeLoop` types | kernel, catalog |
| 2a | `interaction` | user prompts: approvals, `ask_user`, continue question, plan gate, cost card; FIFO, `withdraw` | `Interaction` | kernel |
| 2b | `channels` | adapter contract, registry, managed policy (queue, `maxParallel`, back-off, stall, breaker), probe, secrets-by-ref | `ChannelService` | kernel, config |
| 2b | `budget` | profiles quick/normal/deep, `resolveLimits`, `classifyTask`, compaction thresholds | `Budget` (pure) | kernel, models |
| 2b | `ledger` | append-only cost ledger, cost limit, replacement ranking | `Ledger`, `CostPolicy` | kernel, models, interaction |
| 2b | `permissions` | categories, grants (once/chat/always), shell splitter, fail-closed decisions | `Permissions` | kernel, config, interaction |
| 2b | `roles-skills` | role + skill definitions, validation, tool filter, `writePaths`, copy-on-write, prompt composition inputs | `RoleCatalog`, `SkillCatalog` | kernel, config, models |
| 2b | `scheduling` | `TaskGraph`, `LeaseManager`, deadlock detection | `TaskGraph`, `Leases` (pure) | kernel |
| 2b | `run-state` | journal, idempotency log, pre-image snapshots/revert, scratch dir, chat history | `RunStore`, `Snapshots`, `HistoryStore` | kernel (uses `HostPort`) |
| 5 | `tools` | `ToolRegistry`, built-ins by group (fs-read, fs-write, process, media), `ToolProvider` seam, ingest cap | `ToolRegistry`, `ToolProvider` | kernel, permissions, roles-skills |
| 3a | `compaction` | prune / summarize / clip as pure message transforms | `compact(messages, plan)` | kernel |
| 3a | `context` | prompt composition, `@mentions`, images, `AGENTS.md`/`MEMORY.md` bounds, briefings | `ContextBuilder` | kernel, roles-skills, models |
| 3b | `agent-loop` | `ToolLoop` stream→parse→execute and `createAgentSession` (the only loop builder); declares `Recovery` + fault types | `AgentSession`, `Recovery`, `Fault`, `createProbeLoop` | channels, tools, toolcall-format, compaction, budget, ledger, permissions, models, diagnostics |
| 4 | `orchestration` | hub verbs, plan gate, nested dispatch, `ask_user` routing | `Orchestrator` | agent-loop (incl. `Recovery`), scheduling, roles-skills, run-state, interaction |
| 4 | `recovery` | fault classify, stuck check, layer 0/1, continue question; implements `Recovery` | `createRecovery` | agent-loop, budget, run-state, interaction |
| 4 | `setup` | five-phase setup session (§10): channels, evaluator choice, evaluate, assign, approve + save; draft persistence and undo | `SetupService`, `SetupSession` | channels, models, roles-skills, config, catalog (the benchmark loop is injected as a `ProbeLoop`, no `agent-loop` import) |
| 5 | `runs` | `RunManager`: one pipeline, three strategies, cancel, revert, resume; slash-command parsing (`/direct /quick /deep /resume /permissions /image`) | `RunService`, `parseCommand` | orchestration, recovery, ledger, run-state, permissions, interaction |
| 6 | `app` | wiring, RPC method → service routing, 30 ms event batching toward the host; nothing else | `Core.dispatch` | all |

## 4. Interfaces (contract first)

Sketches, not final code. Naming: verbs for commands, nouns for queries; options object past 4 params; all fallible calls return `Result`.

### kernel
```ts
type Result<T, E extends StewartError = StewartError> = { ok: true; value: T } | { ok: false; error: E };
interface StewartError { code: ErrorCode; message: string; retryable: boolean; cause?: unknown }
interface Clock { now(): number }          interface IdGen { next(prefix: string): string }
interface EventBus<E> { publish(e: E): void; subscribe(fn: (e: E) => void): Unsubscribe }
```

### HostPort (split into narrow ports; hosts implement all)
```ts
interface SecretsPort   { get(ref: string): Promise<Result<string | undefined>>; set(ref: string, v: string): Promise<void> }
interface WorkspacePort { roots(): string[]; stateDir(): string; read(p: string): Promise<Versioned>; edit(p: string, e: Edit): Promise<Result<void>> }
interface ProcessPort   { run(spec: ProcSpec): ProcHandle /* stream, cancel, treeKill */ }
interface EditorPort    { selection(): Selection | undefined; previewDiff(d: Diff): Promise<boolean>; insertText(t: string): void }
interface ProblemsPort  { problems(scope: Scope): Promise<Problem[]> }
type HostPort = SecretsPort & WorkspacePort & ProcessPort & EditorPort & ProblemsPort;
```
Modules request only the port slice they need (`Pick<HostPort, …>`), so tests stub one method.

### channels
```ts
interface ChannelAdapter {                       // implemented per type; contract-tested
  readonly type: string;
  listModels(): Promise<Result<ModelId[]>>;
  probe(model: ModelId): Promise<Result<Capabilities>>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;  // StreamEvent includes { kind: 'error', error }
}
interface ChannelService {                       // the only thing other modules see
  stream(agent: AgentRef, req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  health(channelId: string): Health;             // breaker state
  probe(channelId: string, model: ModelId): Promise<Result<Capabilities>>;
}
```
`ManagedChannel` policy (queue, back-off, stall, breaker) is a decorator over any adapter, so adapters stay free of policy. A new channel type (ACP) is one adapter file plus a registry entry.

### models / budget (pure)
```ts
interface ModelProfiles { resolve(agent: AgentRef, facts: ModelFacts): ModelProfile }
interface Budget {
  limits(input: { role: RoleBudget; profile: ProfileName; model: ModelProfile }): LoopLimits;
  classify(task: TaskSignals): ProfileName;
  compactionAt(profile: ProfileName): { pruneAt: number; summarizeAt: number };
}
```

### ledger
```ts
interface Ledger {
  record(e: UsageEntry): void;                    // append + fsync
  total(runId: string): CostSummary;
}
interface CostPolicy { check(runId: string, next: AgentRef): 'allow' | 'park'; raise(runId: string, by: number): void }
```

### permissions
```ts
interface Permissions {
  decide(req: ToolRequest): Decision;             // total union 'allow' | 'ask'; any internal error yields 'ask' (fail closed)
  ask(req: ToolRequest, ctx: TaskTag): Promise<Result<Grant>>;   // delegates to Interaction (FIFO)
  grants(): Grant[];  revoke(id: string): void;  reset(): void;
}
// interaction (L2a): the one prompt queue
interface Interaction {
  ask<A>(prompt: Prompt<A>, tag: TaskTag): Promise<Result<A>>;   // approval, ask_user, continue, plan gate, cost card
  withdraw(promptId: string, reason: 'timeout' | 'cancel'): void; // emits question.withdrawn
  pending(): PromptView[];
}
```
The shell splitter is an internal pure function; only `decide` is exported.

### tools
```ts
interface Tool<I, O> { name: string; category: ApprovalCategory; parallel: boolean; schema: Schema<I>; run(i: I, ctx: ToolCtx): Promise<Result<O>> }
interface ToolRegistry { for(role: RoleRef): ToolSet; register(p: ToolProvider): void }   // MCP seam
interface ToolProvider { id: string; tools(): Tool<unknown, unknown>[] }
```
Role filtering and `writePaths` are applied in `ToolRegistry.for(role)` as decorators, not inside each tool.

### agent-loop
```ts
interface AgentSession {
  run(turn: TurnInput, signal: AbortSignal): AsyncIterable<LoopEvent>;   // text, tool, usage, compaction, error, done
}
interface AgentSessionFactory { create(spec: { role: RoleRef; agent: AgentRef; tools: ToolSet; limits: LoopLimits }): AgentSession }
```
It is the only place that wires profile → limits → listener → ledger. The loop is a small state machine (`stream → parse → execute → settle`), one function per stage.

### probe-loop (setup benchmark seam)
The contract is declared in `models` (L2a), so `setup` and `agent-loop` both depend downward on it and never on each other.
```ts
// models/api.ts
interface ProbeRequest  { agent: AgentRef; prompt: string; tools: ProbeToolSpec[]; trials: number; maxTurns: number; timeoutMs: number }
interface ProbeObservation { ttftMs: number; tokensPerSec: number; toolRoundTrips: { attempted: number; ok: number }; jsonValid: boolean; editOk: boolean }
type ProbeLoop = (req: ProbeRequest, signal: AbortSignal) => Promise<Result<ProbeObservation>>;

// agent-loop/api.ts
function createProbeLoop(deps: { sessions: AgentSessionFactory }): ProbeLoop;

// setup/api.ts
function createSetupService(deps: { channels: ChannelService; models: ModelProfiles; roles: RoleCatalog; config: ConfigService; host: Pick<HostPort, 'stateDir' | 'get' | 'set'>; probeLoop: ProbeLoop; clock: Clock; ids: IdGen }): SetupService;   // see §10
```
- `createProbeLoop` is a thin function over `AgentSession`. It uses a fixed in-memory sandbox tool set, no permissions and no ledger metering, and enforces the 30 s per-model cap through `timeoutMs` and the signal.
- Because it runs through the real loop, shim reliability is still measured (`toolRoundTrips`).
- `app` builds it once and injects it into `setup`. Setup tests pass a fake `ProbeLoop` that returns canned observations, with no channel, loop or timer needed.
- Negative cases to test: timeout returns an error `Result`, zero round trips scores reliability 0, and malformed JSON sets `jsonValid: false` without throwing.

### scheduling / run-state (pure + stores)
```ts
interface TaskGraph { add(t: Task): Result<void>; ready(): Task[]; complete(id: string, r: TaskResult): Result<void>; blocked(): Task[] }
interface Leases   { acquire(task: string, paths: string[]): Promise<LeaseResult>; release(task: string): void }   // LeaseResult: granted | requeue (deadlock) — an outcome, not an error
interface RunStore { journal(runId: string): Journal; idempotency(runId: string): IdempotencyLog; scratch(runId: string, task: string): string }
interface Snapshots { capture(runId: string, path: string): Promise<Result<void>>; revert(runId: string): Promise<Result<RevertReport>> }
```

### orchestration / recovery
```ts
interface Orchestrator { drive(run: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> }     // hub verbs internal; errors arrive as a RunEvent 'error' variant
// declared in agent-loop/api.ts (L3b), implemented by `recovery`, consumed by `orchestration`
interface Recovery     { attempt(task: Task, fault: Fault): Promise<Result<Recovered | Escalate>> }   // layer 0/1, continue question via Interaction
```
`orchestration` and `recovery` never import each other: both depend on `agent-loop`'s `Recovery` type, and `app` injects the implementation.

### runs
```ts
interface RunService {
  start(req: { mode: 'auto' | 'direct'; message: UserMessage; profile?: ProfileName }): RunHandle;
  resume(runId: string): RunHandle;
  cancel(runId: string): void;  revert(runId: string): Promise<RevertReport>;
}
interface RunHandle { id: string; events: AsyncIterable<RunEvent> }
```
Direct, orchestrated and resume are three `RunStrategy` objects (`plan(req) → TaskGraph`), run by one pipeline. Adding a mode means adding a strategy, not editing `RunManager`.

### app (composition root)
`Core` builds each service once, injects ports, and registers `method → handler` in a table. Handlers are one-liners (`(p) => services.runs.start(p)`). No domain logic lives here, which removes today's ~600-line facade.

## 5. Cross-cutting contracts

- **Events.** One typed `RunEvent` union (versioned in `protocol`). Modules publish; `app` subscribes and forwards. Events flow up, calls flow down, so no cycles.
- **Cancellation.** `AbortSignal` is passed down every async call; no module keeps its own cancel flag.
- **Config access.** Modules receive already-validated, typed slices (`ChannelsConfig`, `RolesConfig`) at construction or via `onChange`, never the raw store.
- **Persistence.** Only `config`, `run-state`, `ledger` and `diagnostics` touch disk, through `HostPort.stateDir()`/atomic helpers.
- **Versioning.** `protocol` changes are additive and optional. Surfaces change by adding optional fields; removals go through a deprecation window.
- **Testing seam per module.** Pure modules: table tests. Stateful modules: an in-memory fake of the port. `ChannelAdapter` and `HostPort` keep their contract suites.

## 6. Enforcement (so it stays healthy)

1. Package boundaries (§9) give most of this for free: `exports` allows only the public entry, and manifests list only lower-layer dependencies. `scripts/check-layers.mjs` (table in `scripts/layers.json`) fails CI if a package depends on its own layer or above, or on a package missing from the layer table. `dependency-cruiser` covers cycles and deep imports inside a package.
2. Lint limits from §1 (`max-lines`, `max-lines-per-function`, `complexity`, `max-depth`, `max-params`).
3. Per-module `README.md` of five lines: purpose, surface, owns, depends on, how to fake it.
4. The `code-health-reviewer` role scores each module folder; Green (≥ 9.5) is the merge bar for new modules, no worse than current for touched ones.
5. `ARCHITECTURE_NOW.md` stays the as-built map; update it with each extraction commit.

## 7. Mapping from today's code and migration

| Today | Becomes |
|---|---|
| `core.ts` facade | `app` router + services; per-method logic moves to owning module |
| `channels/*`, `ManagedChannel` | `channels` (policy as decorator) |
| `modelProfile.ts`, `limits.ts`, `taskSize.ts` | `models`, `budget` |
| `orchestration/RunLedger`, `CostLimit`, `replacements` | `ledger` |
| `tools/approvals`, shell splitter | `permissions` |
| `tools/{shimParser,streamFilter,shimPrompt}` | `toolcall-format` |
| `tools/compaction.ts` | `compaction` |
| `tools/toolLoop.ts`, `agentSession.ts` | `agent-loop` |
| `tools/builtins` | `tools` split into fs-read / fs-write / process / media files |
| `roles.ts`, `skills/*`, `defaults/*` | `roles-skills` |
| `orchestration/{TaskGraph,LeaseManager}` | `scheduling` |
| `orchestration/{IdempotencyLog,writeGuard}`, `history.ts` | `run-state` |
| `orchestration/{recovery,faults}` | `recovery` |
| `orchestration/{OrchestratedRun,roleRunner}` | `orchestration` |
| `runManager.ts` | `runs` with strategies |
| `assign/recommend/bench/catalog/setupContext` | `setup`, `catalog` |
| `images.ts`, `mentions.ts`, `projectContext.ts` | `context` |
| `debug/debug.ts` | `diagnostics` |

Order (each step ships green, behavior-preserving, with tests; strangler style):
0. (Done) Scaffold the workspace (§9; `scripts/new-module.mjs` creates a package): `modules/*` glob, shared `tsconfig.base.json`, `check-layers.mjs`, one empty package per module with its `api.ts`.
1. (Done) Boundary lint in warn mode: `pnpm check:boundaries` (`scripts/boundaries.json` maps today's files to modules; known violations in `boundaries.baseline.json`, only new ones fail; `--update` ratchets).
2. (Done: kernel wire types, toolcall-format, compaction, scheduling, catalog, models, budget.) Extract pure leaves first (each becomes its own package): `toolcall-format`, `compaction`, `scheduling`, `budget`, `models`, `catalog`. Zero behavior risk.
3. (Done; ports moved into `kernel` first. `replacements.ts` stays in core: it needs roles-skills, same layer as ledger.) Extract `permissions` and `ledger` (stateful but self-contained).
4. (Done) Split `HostPort` into narrow ports (`FilesPort`, `WorkspacePort`, `ProcessPort`, `EditorPort`, `ProblemsPort`, `SecretsPort`, `LogPort`; `HostPort` = their intersection, hosts unchanged); leaf callers take `Pick<HostPort, …>`.
5. (Done, in dependency order: `diagnostics`, `context`, `config`, `channels`, `roles-skills`, `tools`, `run-state`, then `agent-loop`; `ToolLoop` is still 360 lines, to split.) Extract `agent-loop` surface (`AgentSession`), then `run-state`.
6. (Done) Extract `orchestration` and `recovery`, injecting `Recovery` (`rt.recoveryService` = `createRecovery(runRoleTask)`; `OrchestrationRuntime`/`RecoveryState` in `agent-loop` `runtime.ts`).
7. Turn `RunManager` into strategies; thin `core.ts` to the router.
Done so far outside the listed steps (needed for the dependency order): `diagnostics`, `context`, `config` (`roles-skills/effective.ts` adds skills + role validation to the merged config; `v1import.ts` stays in core because it needs `catalog`, same layer as `config`).
8. Flip boundary lint to error; ratchet file/function limits down.

Done when: no cycles, no deep cross-module imports, every file within §1 limits, `Core` is a table of one-line handlers, and each module's tests run without constructing any other module above or beside it.

## 8. Decisions

- **Physical form:** every module is its own pnpm package (§9). Chosen over folders for the hard boundary.
- **Setup benchmark:** `setup` does not import `agent-loop`. It takes an injected `ProbeLoop` (see "probe-loop" in §4), implemented by `agent-loop` and wired in `app`.

## 9. pnpm workspace layout

```
pnpm-workspace.yaml      packages: [ "packages/*", "hosts/*", "modules/*" ]
modules/
  kernel/  config/  catalog/  toolcall-format/  diagnostics/
  models/  interaction/
  channels/  budget/  ledger/  permissions/  roles-skills/  scheduling/  run-state/
  tools/  compaction/  context/
  agent-loop/
  orchestration/  recovery/  setup/
  runs/
packages/
  core/        app layer only: composition root, RPC router, event batching (`Core`)
  protocol/  sidecar/  webview/  conformance/      (unchanged)
hosts/vscode  hosts/jetbrains                       (unchanged)
```

Per-package conventions:
- Name `@stewart/<module>`; version-locked, never published separately.
- `src/api.ts` is the only public file. `package.json` has `"exports": { ".": { "types": "./dist/api.d.ts", "default": "./dist/api.js" } }`, so a deep import fails to resolve.
- Dependencies use `"workspace:*"` and only point to packages in lower layers. No peer or dev cycles.
- Each package has its own `tsconfig.json` with project `references` to its dependencies, `vitest` config, and a `test/` folder using in-memory fakes of its ports.
- Per-package scripts `build`, `typecheck`, `test`; `pnpm -r build` stays topological. Developers run one module with `pnpm --filter @stewart/budget... test` (the `...` also runs its dependencies' builds).
- Coverage gate (≥90% line, ≥80% branch) applies per package, so a weak module cannot hide behind a strong one.
- `docs/ARCHITECTURE_NOW.md` module table is updated per extraction commit; `packages/core` shrinks as modules leave it.
- Release packaging bundles the sidecar and VSIX from `@stewart/core`, which pulls the modules in by workspace dependency; no release script change beyond the bundler picking up the new paths.

Risks: more `tsconfig`/build boilerplate (mitigated by `tsconfig.base.json` and a package template script) and slower cold installs (mitigated by the pnpm store). A mistaken layer assignment surfaces immediately as a failing `check-layers.mjs`, which is the intended feedback.

## 10. Setup flow (`setup` module)

Five phases, in order. The user can go back, but a phase only opens when the previous one's gate passes. Nothing is written to `agents.yaml` / `roles.yaml` until the user approves in phase 5.

| # | Phase | User does | Gate to leave |
|---|---|---|---|
| 1 | `channels` | Add, test, remove channels | ≥ 1 channel tested OK with ≥ 1 model |
| 2 | `evaluator` | Choose the channel + model that runs the evaluation (or `rules only`) | An evaluator is chosen and passes a quick structured-output check, or `rules only` is selected |
| 3 | `evaluate` | Pick candidate models, optionally tick the benchmark, run | Evaluation finished (partial results allowed) |
| 4 | `assign` | Review and edit the proposed role → agent table | Assignment valid (same validators as config) |
| 5 | `approve` | Read the summary and diff, approve, save | Approval matches the exact reviewed content; save committed |

### 10.1 Phase detail

**1. Add channels**
- Presets: Ollama, OpenAI, OpenRouter, LM Studio, other OpenAI-compatible, Claude CLI. Fields, key entry and defaults come from the preset.
- Keys go to `SecretsPort` immediately (needed to test) under their final `secretRef`. The draft and the YAML never hold the key. Cancel deletes the secrets this session created.
- Each channel is tested on add (`ChannelService.probe` / list models). Failures map to a fix hint ("Is Ollama running?", "Check the key").
- Existing channels from `channels.yaml` are shown and reusable. Channels added here live in the draft until phase 5.

**2. Choose the evaluator (channel + agent)**
- Choose from models of tested channels. This becomes a draft agent (`channel + model + params`) with billing prefilled from the catalog or live price.
- The picker warns when the agent costs (`$ costs`) or is `unmetered` (cost cannot be capped).
- The agent is checked once with a small structured-output call (valid JSON against the evaluation schema). Fail → pick another or choose `rules only`.
- `rules only` skips every model call in later phases except the optional benchmark.
- The evaluator is only used for judgement (phase 3 rating, phase 4 refinement). It is never used as a benchmark subject unless the user also lists it as a candidate.

**3. Evaluate the agents**
- Candidate set: all models of tested channels, each untickable. Per candidate:
  1. **Probe** capabilities (tools, vision, reasoning, imageGen, context) via the channel.
  2. **Catalog** lookup (price, context, tier, rpm/tpm). Live price list wins.
  3. **Benchmark** (opt-in) through the injected `ProbeLoop`: TTFT, tokens/s, tool round-trips (3 trials), JSON validity, edit ability. 30 s cap per model. The UI shows the estimated time before the run starts.
  4. **Rating** by the evaluator agent (if chosen): one structured call over the evidence table, returning per-model strengths and a quality rating. Invalid or invented model ids are dropped.
- Concurrency per channel is bounded by `maxParallel`. Cancel stops cleanly and keeps results so far.
- A model that fails probing is marked `unavailable` with the reason and excluded from assignment. It does not fail the phase.
- Output: `Evaluation` = `ModelEvidence[]` (+ optional `ModelRating[]`). Persisted in the draft. Benchmark `perf` is staged to be written into `modelCaps` on save.
- **Progress bar.** The Evaluate screen shows one bar with a live count, for example `Agents evaluated: 4 / 15`.
  - `total` = number of ticked candidates, fixed when the run starts. `done` = candidates that reached a final state (`evaluated`, `unavailable` or `skipped`), so `done` only ever goes up and never exceeds `total`.
  - A candidate is counted when all its stages (probe, catalog, optional benchmark) finish, not per stage. The rating call runs after the bar reaches `total` and shows as a separate line (`Rating with <evaluator>…`), so the bar does not stall at 100%.
  - Under the bar: the models running now (up to `maxParallel` per channel) with their current stage (`probing`, `benchmarking`), and a tally `✓ 12 evaluated · ✗ 2 unavailable · 1 skipped`. Failed models are listed with the reason, expandable.
  - Cancel shows the final count (`Cancelled: 9 / 15 evaluated`) and keeps results so far. Re-running evaluates only candidates without a result (those already evaluated count as done from the start).
  - The bar has `role="progressbar"` with `aria-valuenow`, `aria-valuemax` and a text label, so the count is readable without the graphic.
- Progress arrives as `SetupEvent`s, all carrying the running counters:
  - `{ kind: 'progress', done, total, running: { model, stage }[], tally: { evaluated, unavailable, skipped } }`, emitted whenever a candidate starts, changes stage or finishes.
  - `{ kind: 'model', model, result }` with the evidence or the failure reason.
  - `{ kind: 'rating', state: 'started' | 'done' | 'skipped' }`.
  - `{ kind: 'usage', ... }` (tokens/cost of evaluator and benchmark calls, shown to the user).
  - Events are coalesced to at most one `progress` event per 100 ms, and the last one is always delivered, so the count never ends stale.
  - `done`, `total` and `tally` are computed in `evaluate.ts` from one counter object, so the numbers cannot disagree.

**4. Assign agents to roles**
- Inputs: `Evaluation`, `SetupContext` (priority sliders for speed/cost/quality, typical work, workspace scan, hardware), role requirement profiles from `roles-skills` (latency, typical turns, `needsEdit`, `minToolReliability`, cost sensitivity, parallelism).
- Rules engine (pure, no model call): hard filters (tools, vision, imageGen), soft weights, spreading load across near-equal models.
- AI refine (when an evaluator exists): the evaluator proposes changes. Any pick failing a hard requirement is dropped. On failure or invalid output, fall back to the rules result with a visible message.
- Output: `Assignment` = per role `{ agent, score, reason, warnings, billing }`. Unfillable roles are disabled with a reason. The orchestrator is required once any other role is enabled; if it is unfillable, the summary says runs will be direct-only.
- The user edits any role through a capability-filtered dropdown or disables it. Each edit re-runs the same validators config uses (`roles-skills` validation), so an invalid assignment can never reach phase 5.
- Changing priorities re-runs the rules engine only (no new probes or benchmarks).

**5. Approval and save**
- Summary shown for approval:
  - Role → agent table, with disabled roles and reasons.
  - File diff (before/after) for `channels.yaml` (new channels, staged `perf`), `agents.yaml`, `roles.yaml`, and the persisted setup context.
  - Cost view: which roles use costing agents, `unmetered` warnings, evaluator and benchmark spend this session.
- Approval is an explicit action on the exact content shown. `review()` returns an `ApprovalToken` (hash of the file set to be written). `approveAndSave(token)` fails with `stale_approval` if the draft or the files on disk changed since the review.
- Save is all-or-nothing:
  1. Back up the current files to `<stateDir>/setup-backups/<timestamp>/`.
  2. Render the new files, validate the merged result through `ConfigService`. Invalid → nothing written.
  3. Write atomically (temp + rename) in order channels, agents, roles, settings. A failure part-way restores from the backup.
  4. Delete the draft.
- Done screen offers **Undo** (restore the backup) and links to the Settings tabs for fine-tuning.

### 10.2 State machine and persistence

```
channels ⇄ evaluator ⇄ evaluate ⇄ assign ⇄ approve → saved
   └──────────────── cancel (from any phase) → cancelled
```
- Forward moves need the gate; backward moves are free. Going back past `evaluate` keeps the `Evaluation` and marks it stale only if the candidate set or evaluator changed.
- The draft (`SetupDraft`: phase, staged channels without secrets, evaluator choice, candidates, `Evaluation`, `Assignment`, context) is written to `<stateDir>/setup-draft.json` after every phase change. It is schema-versioned and expires after 7 days. After an IDE restart the wizard resumes at the last completed phase.
- `cancel()` removes the draft and the secrets created in this session, and writes no YAML.

### 10.3 Surface

```ts
type Phase = 'channels' | 'evaluator' | 'evaluate' | 'assign' | 'approve' | 'saved' | 'cancelled';

interface SetupService {
  open(projectId: string): Promise<Result<SetupSession>>;      // new, or resumes the persisted draft
}
interface SetupSession {
  readonly phase: Phase;  readonly draft: SetupDraftView;
  // 1
  addChannel(spec: ChannelSpec): Promise<Result<ChannelStatus>>;
  testChannel(id: string): Promise<Result<ChannelStatus>>;
  removeChannel(id: string): Promise<Result<void>>;
  // 2
  chooseEvaluator(choice: { channel: string; model: string } | 'rules'): Promise<Result<void>>;
  // 3
  evaluate(opts: { candidates: ModelRef[]; bench: boolean }, signal: AbortSignal): AsyncIterable<SetupEvent>;  // ends with { kind: 'evaluated' } or { kind: 'error' }
  // 4
  assign(ctx: SetupContext): Promise<Result<Assignment>>;
  edit(roleId: string, agent: AgentRef | null): Result<Assignment>;     // revalidates
  // 5
  review(): Result<ReviewSummary & { token: ApprovalToken }>;
  approveAndSave(token: ApprovalToken): Promise<Result<SavedReport>>;
  undo(): Promise<Result<void>>;                                       // restore last backup
  // navigation
  back(): Result<Phase>;  cancel(): Promise<void>;
}
```
Errors use the shared `StewartError` codes: `no_channel`, `evaluator_invalid`, `evaluation_incomplete`, `assignment_invalid`, `stale_approval`, `save_failed`.

### 10.4 Protocol (additive)

New methods: `setup.open`, `setup.channel.add`, `setup.channel.remove`, `setup.channel.test`, `setup.evaluator.set`, `setup.evaluate` (streams `setup.progress` events), `setup.assign`, `setup.edit`, `setup.review`, `setup.save`, `setup.undo`, `setup.cancel`. Existing `channel.test`, `channel.probe` and `setup.recommend` stay for one release, with `setup.recommend` marked deprecated and mapped onto phases 3–4.

### 10.5 Internal files (each ≤ 300 lines)

`session.ts` (state machine + guards), `channelsStep.ts`, `evaluatorStep.ts`, `evaluate.ts` (probe/catalog/bench orchestration), `rating.ts` (evaluator call + validation), `score.ts` (pure rules), `refine.ts` (AI refine + fallback), `summary.ts` (diff, cost view, token), `save.ts` (backup, validate, atomic write, rollback), `draftStore.ts`.

### 10.6 Webview

Five wizard screens map 1:1 to phases (progress bar of five). The webview holds no setup logic: it renders `SetupSession` state and `SetupEvent`s and sends the calls above. Compared with today's wizard (`Welcome → Channels → Discover → Evaluator → Review → Done`): the Welcome text moves into the Channels screen, Discover and the benchmark merge into Evaluate, the evaluator choice moves ahead of evaluation, and Review splits into editable Assign and read-only Approve with a diff.

### 10.7 Gaps this closes

Resume after IDE restart (draft), YAML undo backup (backup + Undo), approval bound to exact content (token). Still open: Claude CLI auto-detect (can be added as a preset hook in phase 1) and the quality-vs-free toggle (an extra priority control in phase 4).

### 10.8 Tests (positive and negative)

- Gates: each forward move blocked until its gate passes; back moves allowed; cancel from every phase leaves no files or secrets.
- Channels: failing test shows a hint and blocks; secret never appears in draft or YAML.
- Evaluator: invalid JSON from the evaluator rejects it; `rules only` makes no model call.
- Progress: `done` is monotonic and ≤ `total`; `done + remaining = total` at every event; `tally` sums to `done`; a failed model still increments `done`; cancel at 9/15 reports 9/15; re-run counts already-evaluated models as done; coalescing never drops the final event; zero candidates is rejected, not shown as `0 / 0`.
- Evaluate: failed probe marks `unavailable` only; cancel keeps partial results; fake `ProbeLoop` covers timeout and malformed JSON; invented model ids from the rating are dropped.
- Assign: hard-filter violations never assigned; AI pick failing a requirement dropped with fallback message; edit to an invalid choice returns `assignment_invalid`; priority change re-scores without probing.
- Approve/save: token mismatch after a draft or disk change returns `stale_approval`; invalid merged config writes nothing; mid-write failure restores the backup; Undo restores the previous files; draft deleted after success.
- Resume: restart mid-`evaluate` resumes with prior results; expired or version-mismatched draft is discarded with a notice.

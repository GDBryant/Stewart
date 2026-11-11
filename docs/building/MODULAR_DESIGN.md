# Stewart — Modular Design (healthy-code structure)

Status: implemented through §7 step 7 (all 22 modules extracted, `core.ts` is a router); step 8 (lint limits) deferred. Originally derived from `project_features.md`; §3 now reflects the as-built manifests and §11 lists where the build deviates from the §4 sketches. As-built detail lives in `../ai_docs/ARCHITECTURE_NOW.md`; progress in `MODULAR_MIGRATION_STATUS.md`. Complements `ARCHITECTURE_REFACTORING.md` (R1–R3) and scores against the `code-health` rubric.

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
L2b  domain       roles-skills · code-health · channels · budget · ledger · permissions · scheduling · run-state
L2a  domain base  models · interaction
L1   platform     config · catalog · toolcall-format · diagnostics
L0   kernel       Result, errors, ids, Clock, IdGen, EventBus, schema helpers, HostPort types
```

`interaction` is the single owner of user-facing prompts: a FIFO queue showing one card at a time (approvals, `ask_user`, continue question, plan gate, cost card, fallback switch, resume confirm). `runs` holds one `Interaction` per project and hands it down as `rt.prompt` (questions) and `rt.approve` (grant gate → approval card), both bound to the run's abort signal. Owners build typed `Prompt<A>` values (`recovery/continue.ts`, `orchestration/prompts.ts`) and handle `withdrawn` explicitly. `permissions` prompts through the `Interaction` it is given; `ledger` doesn't prompt.

### Outside core

| Part | Surface | Rule |
|---|---|---|
| `protocol` | JSON-RPC methods, `RunEvent` union, `PROTOCOL_VERSION`, capability flags | Additive only; only contract shared by core, sidecar, hosts and webview |
| `sidecar` | stdio JSON-RPC server → `Core.dispatch`; reverse-RPC → `HostPort` | Transport only, no domain logic |
| `hosts/vscode`, `hosts/jetbrains` | implement `HostPort` (+ supervision for JetBrains); load the webview | Pass the `HostPort` contract suite; no Stewart logic |
| `webview` | state store + `bridge` (protocol only); chat, settings, setup, approvals as separate UI modules | Never imports core; renders `RunEvent`s |

## 3. Modules and their surfaces

Each row: layer (matches `scripts/layers.json` and §2), what it owns, the surface others may use, and the `@stewart/*` dependencies declared in its manifest as built (`@stewart/protocol` sits outside the layer table and is allowed from any layer). Surfaces are sketched in §4; each module's `README.md` says how to fake it.

| L | Module | Owns (feature) | Surface | Depends on (as built) |
|---|---|---|---|---|
| 0 | `kernel` | wire types, `Clock`, `IdGen`, `EventBus`, `HostPort` + narrow ports, test fakes | types + tiny helpers, `fakeHost`/`fakeFetcher` | protocol |
| 1 | `config` | YAML load, zod validate, shipped<user<project merge by id, `SelfWriteGuard`, atomic write, user config dir | `loadConfig` (raw), `ConfigStore`, schemas | — |
| 1 | `catalog` | bundled price/limits/context data, `lookupModelInfo`, `costTier`, `normalizeModel` | pure functions | — |
| 1 | `toolcall-format` | shim parser, JSON repair, alias map, stream filter, shim prompt | `parseToolCalls`, `ToolCallStreamFilter`, `shimPrompt` (pure) | kernel |
| 1 | `diagnostics` | debug log sink, redaction, retention | `DebugLogger`, `DebugSink` | protocol |
| 2 | `models` | one merge of caps/probe/bench/catalog/price → `ModelProfile` | `resolveModelProfile`, `profileFromChannel` (pure), `ProbeLoop` contract | kernel, catalog |
| 2 | `interaction` | FIFO prompt queue: approvals, `ask_user`, continue, plan gate, cost card, fallback, resume; timeout/abort `withdraw` | `Interaction`, `Prompt<A>`, `approvalPrompt`, `questionPrompt` | kernel, protocol |
| 3 | `channels` | adapter contract, registry, managed policy (queue, `maxParallel`, back-off, stall, breaker), probe, secrets-by-ref, channel facade | `ChannelAdapter`, `ManagedChannel`, `ChannelRegistry`, `ChannelService` (rebuild/get/require/health/listModels/probe/setSecret) | kernel, catalog, diagnostics, models |
| 3 | `budget` | profiles quick/normal/deep, `resolveLimits`, `classifyTask`, compaction thresholds | pure functions | catalog, models |
| 3 | `ledger` | append-only cost ledger, cost limit | `RunLedger`, `CostLimit`, `costOfCall` | kernel |
| 3 | `permissions` | categories, grants (once/chat/always), tool previews, shell splitter, approval gate | `Permissions` (decide/ask/gate), `Grants`, `categoryOf`, `splitShellPrograms` | kernel, interaction |
| 3 | `roles-skills` | role + skill definitions, validation, tool filter, `writePaths`, copy-on-write, prompt composition, effective config (`loadConfig` + skills + role validation) | `loadConfig`, `composeRolePrompt`, role/skill helpers | kernel, config, models |
| 3 | `code-health` | health report types, inventory batching, LOC-weighted aggregation, Markdown render, request routing + source-file filters | `bandFor`, `batchInventory`, `mergeReports`, `aggregate`, `renderReport`, `isHealthCheckRequest`, `isSourceFile` (pure) | — |
| 3 | `scheduling` | `TaskGraph`, `LeaseManager`, deadlock detection | `TaskGraph`, `LeaseManager` (pure) | — |
| 3 | `run-state` | idempotency log, pre-image snapshots/revert, chat history | `IdempotencyLog`, `revertRunSnapshots`, `ChatHistoryStore` | kernel |
| 4 | `compaction` | prune / summarize / clip as pure message transforms | pure functions | kernel |
| 4 | `context` | `@mentions`, image limits, `AGENTS.md`/`MEMORY.md` bounds | `expandMentions`, `normalizeImages`, `loadProjectContext` | kernel |
| 5 | `tools` | `ToolRegistry`, built-ins by group (fs-read, fs-write, process, media), role guards, lease wrapper | `ToolRegistry`, `projectTools`, `roleRegistry`, `leasedTools` | kernel, code-health, config, context, permissions, roles-skills, run-state, scheduling |
| 6 | `agent-loop` | `ToolLoop` stream→parse→execute, `createAgentSession` (the only loop builder), fault classification; declares `OrchestrationRuntime`/`RunRuntime`, `Recovery` + fault types | `createAgentSession`, `createProbeLoop`, `classifyFault`, `Recovery`, runtime types | budget, channels, compaction, config, interaction, kernel, ledger, models, permissions, protocol, roles-skills, run-state, scheduling, toolcall-format, tools |
| 7 | `orchestration` | hub verbs, plan gate, nested dispatch, `ask_user` routing, role task runner, replacement ranking | `runOrchestrated`, `runRoleTask`, `orchestrationTools`, replacements | agent-loop, budget, channels, code-health, compaction, config, context, interaction, kernel, ledger, models, permissions, roles-skills, run-state, scheduling, tools |
| 7 | `recovery` | fault classify, stuck check, layer 0/1, continue question; implements `Recovery` | `createRecovery`, `continueQuestion`, scratch helpers | agent-loop, config, interaction, kernel, permissions, roles-skills, scheduling, tools |
| 7 | `setup` | rules scorer, AI-refined assignment, model benchmark, workspace/hardware scan (the five-phase session of §10 is not built) | `scoreAssignments`, `recommendAssignments`, `benchModel` (takes an injected `ProbeLoop`), `scanWorkspace` | catalog, channels, config, kernel, models, roles-skills |
| 8 | `runs` | `RunService`: one pipeline, three strategies, cancel, revert, resume; slash-command parsing (`/direct /quick /deep`) | `RunService`, `parseChatCommand` | agent-loop, budget, channels, config, context, interaction, kernel, ledger, orchestration, permissions, protocol, recovery, roles-skills, run-state, scheduling |
| 9 | `app` (`packages/core`) | wiring, RPC method → handler table, 30 ms event batching toward the host, `v1import` | `Core.dispatch` | all |

## 4. Interfaces (contract first)

Sketches, not final code; the build kept the existing concrete types (`ManagedChannel`, `Grants`, `ToolLoop`, `RunRuntime`) rather than introducing these facades — §11 lists each deviation. Naming: verbs for commands, nouns for queries; options object past 4 params; all fallible calls return `Result`.

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
class ChannelService {                           // — built; the only thing other modules see
  rebuild(channels: ChannelSpec[], host): Promise<Map<string, string>>;  // builds ManagedChannels, returns secrets by ref
  get(id: string): ManagedChannel | undefined; require(id: string): ManagedChannel;
  ids(): string[]; health(id: string): 'healthy' | 'unhealthy' | 'backoff' | 'missing';
  listModels(id: string): Promise<string[]>; probe(id: string, model: string): Promise<Partial<ModelCaps>>;
  setSecret(ref: string, value: string | undefined): number;
}
// stream(agent, req, signal) from the sketch is not on it: consumers still call ManagedChannel.chat via rt.channelFor, which resolves through ChannelService.require.
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

### permissions — built
```ts
class Permissions {
  decide(req: PermissionRequest, runGrants: Grants): 'allow' | 'ask';             // any internal error yields 'ask' (fail closed)
  ask(req: PermissionRequest, runGrants: Grants, tag: PromptTag, signal?): Promise<PermissionDecision>;  // one card on the Interaction (FIFO)
  gate(runId: string, signal: AbortSignal, runGrants?: Grants): ApproveFn;        // per-run rt.approve; session grants are private
}
// grants()/revoke(id)/reset() from the sketch are not built — Grants.revoke(scope?, category?) exists but has no core-side caller yet.
// interaction (L2): the one prompt queue — built
type Prompt<A> =
  | { kind: 'approval'; tool: string; args: unknown; category: string; decode(g: PromptGrant): A }
  | { kind: 'question'; topic: PromptTopic; question: string; options?: string[]; timeoutMs?: number; decode(answer: string): A };
type PromptOutcome<A> = { kind: 'answered'; value: A } | { kind: 'withdrawn'; reason: 'timeout' | 'cancel' };   // outcome union, never rejects
interface Interaction {
  ask<A>(prompt: Prompt<A>, tag: PromptTag, signal?: AbortSignal): Promise<PromptOutcome<A>>;
  withdraw(promptId: string, reason: 'timeout' | 'cancel'): boolean;   // shown question → question.withdrawn
  resolveApproval(id: string, g: PromptGrant): boolean;  resolveAnswer(id: string, a: string): boolean;   // shown prompt only
  pending(): PromptView[];   // shown first, then queued
}
```
FIFO: one prompt is shown at a time, and the next is shown when it settles. A timer starts when its prompt is shown, not when it is queued. An abort removes a queued prompt silently, or withdraws the shown one. Card ids and the `approval.request` / `ask_user` / `question.withdrawn` events are unchanged on the wire.
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

### probe-loop (setup benchmark seam) — built
The contract is declared in `models` (L2), so `setup` and `agent-loop` both depend downward on it and never on each other. One probe = one tool-call trial; `setup` owns trial counts and scoring.
```ts
// models/api.ts — C is the channel type, generic because channels sits above models
interface ProbeRequest { model: string; tool: ToolSpec; reply: string; prompt: string; maxTurns: number; timeoutMs: number }
type ProbeResult = { kind: 'ok'; toolOk: boolean } | { kind: 'failed'; message: string };   // outcome union; never throws
type ProbeLoop<C = unknown> = (channel: C, req: ProbeRequest) => Promise<ProbeResult>;

// agent-loop/api.ts
function createProbeLoop(deps: { clock: Clock }): ProbeLoop<ManagedChannel>;

// setup/api.ts
function benchModel(channel: ManagedChannel, model: string, clock: Clock, probe: ProbeLoop<ManagedChannel>): Promise<ModelPerf>;
```
- `createProbeLoop` is a thin function over `createAgentSession`: a synthetic `bench` agent, one terminal sandbox tool that returns `req.reply`, auto-approve, no ledger metering, `maxModelTurns: req.maxTurns`, `AbortSignal.timeout(req.timeoutMs)` (30 s cap per probe). A failed loop or thrown error (timeout) maps to `failed`.
- Because it runs through the real loop, shim reliability is still measured.
- `app` (`Core.probeLoop`) builds it once and injects it via the `channel.probe` bench handler. Setup tests pass a recording fake `ProbeLoop`, no agent loop needed; the speed and JSON probes still call `channel.chat` directly and use a scripted channel.
- Tested negatives: a `failed` trial leaves `toolReliability`/`editOk` undefined, zero successful trials scores 0, `tools: none` skips the probe, malformed JSON sets `jsonOk: false`, a hanging channel times out to `failed` without throwing.

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
Direct, orchestrated and resume are three `RunStrategy<Req>` objects — `plan(svc, projectId, req, ctx) → RunPlan | Refusal` builds the Run and seeds task records (direct: one record; resume: the replayed graph; orchestrated: none), `execute(svc, run, rt, req, ctx) → RunOutcome` drives the shared runtime — run by one `runPipeline` (plan → register + `run.started` → idem/journal/`buildRunRuntime` → execute → status/cost/journal/history/`run.finished`). Adding a mode means adding a strategy, not editing `RunService`. — built

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

1. (Done) Package boundaries (§9) give most of this for free: `exports` allows only the public entry, and manifests list only lower-layer dependencies. `scripts/check-layers.mjs` (table in `scripts/layers.json`) fails CI (`ci.yml` runs `check:layers` and `check:boundaries`) if a package depends on its own layer or above, on a package missing from the layer table, or exposes more than the `.` export. `dependency-cruiser` (`.dependency-cruiser.cjs`, `pnpm check:cycles`, in CI) fails on any intra-package cycle, type-only imports included; strategies/handlers depend on `RunHost`/`CoreCtx` interfaces in `types.ts` files rather than the concrete class.
2. (Deferred, step 8) Lint limits from §1 via the full eslint rule set (`max-lines`, `max-lines-per-function`, `complexity`, `max-depth`, `max-params`) across every package. Today `check-boundaries` enforces file size across all packages (>300 lines warns, >500 fails; `softLines`/`maxLines` in `scripts/boundaries.json`). Coverage (≥90% line, ≥80% branch) is enforced per package by `pnpm test:coverage` in CI.
3. (Done) Per-module `README.md` of five lines: purpose, surface, owns, depends on, how to fake it. `scripts/new-module.mjs` writes the template.
4. The `code-health-reviewer` role scores each module folder; Green (≥ 9.5) is the merge bar for new modules, no worse than current for touched ones. Not yet run over `modules/*`.
5. (Done) `../ai_docs/ARCHITECTURE_NOW.md` stays the as-built map; update it with each extraction commit.

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
7. (Done) `RunManager` → `RunService` in `runs` with `direct`/`orchestrated`/`resume` strategy objects + `parseChatCommand`; `events.ts` → `kernel`; `setup` files → `setup` module; `core.ts` = router over `handlers/*`; `interaction` extracted (`Interaction`: approval/ask/askTimed cards + resolve; `RunService` delegates; prompts reach modules via `rt.ask`/`rt.askTimed`/`rt.approve` rather than a direct `interaction` import — the FIFO queue / `Prompt<A>` generic from §4 is not built).
Done so far outside the listed steps (needed for the dependency order): `diagnostics`, `context`, `config` (`roles-skills/effective.ts` adds skills + role validation to the merged config; `v1import.ts` stays in core because it needs `catalog`, same layer as `config`).
8. (Deferred) Flip boundary lint to error; ratchet file/function limits down. Decision: use the full eslint rule set from §6 (`max-lines`, `max-lines-per-function`, `complexity`, `max-depth`, `max-params`) across all packages rather than a custom script; extend the size scan to `modules/*`. Not started.

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
- Each package has its own `tsconfig.json` (extends `tsconfig.base.json`, `composite: true`, project `references` to its `@stewart/*` deps — generated by `scripts/sync-tsrefs.mjs`, drift fails `pnpm check:tsrefs` in CI; `typecheck` runs `tsc -p tsconfig.json --composite false --noEmit`), a `vitest.config.ts` with the coverage thresholds, and a `test/` folder using in-memory fakes of its ports.
- Per-package scripts `build`, `typecheck`, `test`; `pnpm -r build` stays topological. Developers run one module with `pnpm --filter @stewart/budget... test` (the `...` also runs its dependencies' builds).
- Coverage gate (≥90% line, ≥80% branch) applies per package (`test:coverage` script, v8 provider, `include: ["src/**"]`), so a weak module cannot hide behind a strong one.
- `docs/ai_docs/ARCHITECTURE_NOW.md` module table is updated per extraction commit; `packages/core` shrinks as modules leave it.
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

## 11. As-built deviations from the sketches

Verified against the code at M-7b (`d8e3722`). Each is a conscious scope cut, not an oversight; revisit when the listed trigger appears.

| Sketch (§) | As built | Why / trigger to revisit |
|---|---|---|
| `Result<T, StewartError>` for all fallible calls (§1, §4) | Modules throw or return `T \| undefined`; errors surface as `RunEvent` variants or thrown `Error`s caught at the strategy/handler edge | Sweeping change across every surface; do it per module when a module is next reworked |
| `ChannelService.stream(agent, req, signal)` (§4) | `ChannelService` resolves/health/probe/secrets; consumers still call `ManagedChannel.chat` via `rt.channelFor`, which resolves through `ChannelService.require` | Add when a second consumer needs agent→channel resolution outside the runtime |
| `Permissions.grants()/revoke(id)/reset()` (§4) | Session grants are private to `Permissions`; `Grants.revoke(scope?, category?)` exists but has no core-side caller; `/permissions` is webview-only | Add when a `permissions.*` RPC appears |
| `setup` five-phase session, drafts, undo (§3, §10) | `setup` holds the scorer, recommend, bench and workspace scan; the wizard flow lives in the webview against `setup.recommend`/`channel.probe` | §10 is the plan for the next setup iteration; not part of the extraction |
| `RunHandle.events: AsyncIterable` (§4) | Runs emit through the shared `EventBus`; handlers return `{ runId }` | Protocol is event-push; an iterable per run would duplicate the bus |
| `ToolRegistry.for(role)` decorator (§4) | `roleRegistry(registry, role)` function in `tools/roleRegistry.ts`; `leasedTools` wraps for leases | Same shape, free function instead of method |
| `v1import` into `config` (§3) | Stays in `packages/core` because it needs `catalog` (same layer as `config`) | Move when `catalog` and `config` split layers |
| Slash commands `/resume /permissions /image` in `parseCommand` (§3) | Only `/direct /quick /deep`; `/resume` is the `chat.resume` RPC, the others are webview-side | Add when a core-side command appears |

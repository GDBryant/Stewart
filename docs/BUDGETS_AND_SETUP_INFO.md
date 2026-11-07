# Model-aware budgets and richer setup information (spec)

Status: **M1–M5 implemented** (`b16e2ce`..`6d4ea05`, branch `active-background-tasks`). The v1 continue-question/split machinery is now ported (`orchestration/recovery.ts`, `docs/FAULT_RECOVERY.md`) — M6 escalation is unblocked but not yet built.

## Problem

1. Turn/time limits are model-blind. `roleTurnBudget(role)` (`packages/core/src/roles.ts`) returns the role's `turnBudget` (default 25) and `DEFAULT_LIMITS.toolTimeoutMs` is a flat 60 s (`tools/toolLoop.ts`). A slow local model and a fast paid model get the same budget, and a one-file bash script gets the same budget as a monorepo refactor.
2. The setup evaluator decides on thin data. `scoreAssignments` (`assign.ts`) uses what the name and `probeCaps` reveal: parameter size parsed from the name, `reasoning`, coder-in-name, native tools, context, local/free. It has no speed, price, reliability, workload or hardware information. The AI evaluator (`setup.recommend {evaluator:"ai"}`) sees the same fields.

## Goals

- Fast, cheap result for small tasks; long-running allowed for big ones.
- Per-model budgets derived from measured speed and cost, not hand-set per role.
- Setup evaluator (rules and AI) receives measured, priced, role-aware, environment-aware input.

Non-goals: new providers, UI redesign beyond the fields listed, changing fault-recovery layers (`docs/FAULT_RECOVERY.md`).

## Part A. Four information upgrades for the setup agent

### A1. Measured benchmarks (`ModelPerf`)

Extend Discover (`channel.probe`, `core.ts` ~L388, cache `probeCache`) with an optional `bench: true` flag that runs a short suite per model, with a hard 30 s cap each. The bench drives `ToolLoop` (or an extracted shim prompter/parser), not raw `channel.chat` — shim-mode tool calls only exist after shim parsing, so a channel-level call cannot measure real reliability. `claude-cli` pays a process spawn per probe.

| Probe | Measures | Method |
|---|---|---|
| Latency | `ttftMs` | stream a 1-token reply to "ok" |
| Throughput | `tokPerSec` | stream ~150 tokens, use usage counts if reported, else char/4 |
| Tool round-trip | `toolReliability` 0..1 | 3 trials: forced single tool call with a trivial schema; score = valid parsed calls / 3 (native or shim path as configured) |
| Format | `jsonOk` | ask for a fixed JSON object, validate |
| Edit | `editOk` | give 10-line text + instruction, expect an `EditFile`-style call; check result |

New type (in `channels/types.ts`, beside `ModelCaps`):

```ts
interface ModelPerf { ttftMs?: number; tokPerSec?: number; toolReliability?: number;
  jsonOk?: boolean; editOk?: boolean; benchedAt: number; benchVersion: number }
```

- Add `perf?: ModelPerf` to the probe result and cache it (key `channel/model`, invalidate on `benchVersion` change or model digest change for Ollama). `probeCache` is in-memory only today.
- Persist to config as `modelCaps[model].perf` (schema `modelCaps` in `config/schema.ts`; all fields optional so old YAML stays valid). Follow `applyProbes` precedence: probed/benched values never override user-set `modelCaps` fields.
- Cost: bench is opt-in (checkbox "Measure speed (up to ~2.5 min per model)"), skipped for `billing: priced` models unless ticked, and never run on image-gen models.
- Failure: a failed or timed-out probe leaves the field undefined; the evaluator treats undefined as "unknown", never as zero.

### A2. Pricing and limits catalog

- New file `packages/core/src/catalog.ts` exporting `lookupModelInfo(channelType, model): { inPerMTok?, outPerMTok?, contextTokens?, rpm?, tpm?, family?, tier? } | undefined`. Data lives in `packages/core/src/catalog.data.json` (versioned, `updated` date field), matched by normalised model-name regex. Seed with the models in `docs/COMPATIBILITY.md` plus the Claude 5 family and the common OpenAI/OpenRouter ones.
- Local channels (Ollama, LM Studio): price 0, `billing: "free"`; speed comes from A1 or an unknown value, plus the hardware profile (A4).
- Wizard prefills `agent.price` and `agent.billing` from the catalog (user-editable, source shown as "catalog 2026-11"). Existing `agent.price` always wins over the catalog.
- Live provider pricing: `listModels` returns `string[]` only, so add an optional `ChannelAdapter.priceList?(cfg, secret): Promise<Record<string, { inPerMTok: number; outPerMTok: number }> | undefined>` (OpenRouter `/models` on `openai-compatible`, undefined elsewhere); fall back to catalog.
- Evaluator input gains `costPerMTokBlended` (e.g. 3:1 in:out) and `costTier: free | low | mid | high` (thresholds as constants in `catalog.ts`, tested).
- When the catalog supplies `family`/`tier` for a hosted model, drop the hosted=70B guess in `effectiveSize` (`assign.ts`).

### A3. Role requirement profiles (richer `ROLE_PROFILES`)

Extend `Profile` in `assign.ts`:

```ts
interface Profile { ...existing;
  latency: "interactive" | "batch";        // does a human wait on this?
  typicalTurns: [min: number, max: number]; // expected tool turns
  needsEdit?: boolean;                      // requires editOk when benched
  minToolReliability?: number;              // hard filter if perf known, warning if unknown
  costSensitivity: "low" | "medium" | "high";
  parallelism?: "high" | "low";             // many instances at once -> prefer cheap/fast
}
```

Initial values (adjust in review): orchestrator, planner: batch, 3-8 turns, low sensitivity, strong reasoning. code-writer, tester: batch, 10-40 turns, `needsEdit`, `minToolReliability 0.67`. investigator: interactive, 5-20 turns, high sensitivity, high parallelism. code-reviewer: batch, 5-15. document-writer: interactive, 1-5, high sensitivity.

Scoring changes in `scoreAssignments`: add terms for `tokPerSec` (weighted when `latency=interactive`), cost tier (weighted by `costSensitivity`), and `toolReliability`/`editOk` (hard filter when measured, soft warning when unknown). Keep all existing terms; weights live in one exported constant object so tests can pin them. The AI evaluator prompt receives the same profile and perf/cost data as a compact table.

### A4. Environment and workload context (`SetupContext`)

Gather once at setup start and pass to both evaluators:

```ts
interface SetupContext {
  workspace?: { files: number; loc: number; languages: Record<string, number>; monorepo: boolean; sizeClass: "small"|"medium"|"large" };
  hardware?: { os: string; ramGb: number; gpus?: { name: string; vramGb: number }[] };
  priorities: { speed: 1|2|3; cost: 1|2|3; quality: 1|2|3 };   // wizard sliders, default 2/2/2
  typicalWork?: "scripts" | "features" | "refactors" | "mixed";
}
```

- Workspace scan: respect `.gitignore`, cap at ~20k files / 2 s, never read file contents beyond counting lines. Reuse the sizing from Part B (single implementation).
- Hardware: `os.totalmem()`; GPU via `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` when present, else undefined. Never fail setup on detection errors. Used to flag "model likely too large for VRAM/RAM" (rule of thumb: params(B) x 0.6 GB at Q4) as a warning, not a filter.
- `priorities` reweight scoring (speed, cost and quality multipliers on the A3 terms). Persist to `settings` so re-running setup starts from the previous answers.
- Protocol: extend `setup.recommend` params with `context?: SetupContext` and `bench?: boolean`; response unchanged except each assignment's `reason` cites the deciding facts (e.g. "42 tok/s, free, tool 3/3").

## Part B. Budget profiles and model factors

### B1. Profiles

New settings block (`settingsSchema`, all defaulted so existing configs load):

```yaml
budgets:
  quick:  { turnMultiplier: 0.4, timeoutMultiplier: 0.5, allowSplit: false, maxRunMinutes: 10 }
  normal: { turnMultiplier: 1.0, timeoutMultiplier: 1.0, allowSplit: true,  maxRunMinutes: 60 }
  deep:   { turnMultiplier: 2.0, timeoutMultiplier: 3.0, allowSplit: true,  maxRunMinutes: 0 }   # 0 = unlimited
```

`maxRunMinutes` feeds the existing `maxRunHours` mechanism (`runManager.ts` ~L337/L413) at finer granularity; keep `maxRunHours` as the global ceiling (effective = the smaller non-zero value). The elapsed-time check lives only in orchestrated dispatch (`orchestrator.ts` ~L259); add the same check in `runManager.drive()` so the cap applies to direct runs too.

### B2. Model factors

Derived at agent-load time, overridable per agent (`agent.budget?: { turnFactor?, timeoutFactor? }`):

- `speedFactor = clamp(refTokPerSec / tokPerSec, 0.5, 4)` with `refTokPerSec = 40`. Slow models get a longer timeout (`timeoutFactor`). Unknown speed = 1.
- `costFactor` for `costs: true` agents: `clamp(refBlendedCost / blendedCost, 0.5, 1.5)`, with `refBlendedCost` constant in code. Expensive models get a lower `turnFactor`; cheap or free models get a higher one.
- `reliabilityFactor = toolReliability < 0.67 ? 0.75 : 1` (an unreliable tool user wastes turns).
- Effective values:
  - `maxModelTurns = round(role.turnBudget x profile.turnMultiplier x turnFactor)`, clamped to `[3, maxWorkerTurnsCeiling x profile.turnMultiplier]` (`maxWorkerTurnsCeiling` is a v1 setting absent from v2 — add it to `settingsSchema`, default 60, when landing this).
  - Per-model-call and tool timeout = `base x profile.timeoutMultiplier x timeoutFactor`.
- `role.turnBudget: "unlimited"` stays unlimited; the profile only changes timeouts and `maxRunMinutes`.

Implementation seam: replace `roleTurnBudget(role)` call sites (`roleRunner.ts:99`, `orchestrator.ts:110`, `runManager.ts:464`) with `resolveLimits({ role, agent, profile })` returning `LoopLimits`. Keep `roleTurnBudget` as a thin wrapper for compatibility. Add `modelCallTimeoutMs` to `LoopLimits`: it does not exist today — channels enforce only `stallTimeoutMs` (per-chunk stall, a `ChannelDeps` constant), so a slow-but-progressing call can run forever. Enforce it per call via `AbortSignal.timeout` composed onto `req.signal` in `ToolLoop`.

### B3. Task-size classifier

`classifyTask(prompt, ctx): "quick" | "normal" | "deep"`, pure and deterministic (no model call), in `packages/core/src/taskSize.ts`:

Signals: prompt length; keyword hits (`script`, `one-liner`, `snippet`, `regex`, `explain` push to quick; `refactor`, `migrate`, `across`, `all tests`, `architecture`, `entire` push to deep); explicit file mentions (count); `workspace.sizeClass` (reused from A4, cached per workspace, refreshed on a 24 h TTL); attached images or files; presence of a plan (orchestrated run pushes to deep).

Score = weighted sum, thresholds as constants. Example outcomes that must hold (tests): "write a bash script that tars logs and rsyncs them" in any workspace -> quick; "refactor the auth layer across all packages" in a large workspace -> deep; ambiguous -> normal.

Precedence: user override (`/quick`, `/deep`, or a UI toggle in the chat bar) > classifier > `normal`. Show the chosen profile as a small badge in the chat header and in the background-task row (the active-tasks UI added in `e6a149e`).

### B4. Escalation

Prerequisite: the v2 TS core has no continue question, no layer-1 split, and no `maxRecoveryDepth`/`maxContinuations` — `docs/FAULT_RECOVERY.md` describes the removed v1 Kotlin. `TURN_LIMIT` currently just stops the run (`orchestrator.ts`, `runManager.ts`, `roleRunner.ts`). Land the v1 recovery port first, or descope this section to auto-escalation only.

- `quick` that hits `TURN_LIMIT` escalates to `normal` automatically, once, with a log line `[run <id>] profile quick -> normal` (category `recovery`), before the continue question appears. `normal` -> `deep` is offered through the continue question ("Continue as deep run"). Without the port, a `normal` run at `TURN_LIMIT` stops as today.
- Never de-escalate mid-run.
- `allowSplit: false` in quick skips layer 1 once split exists; other fault-recovery layers and limits are unchanged.

## Data and compatibility

- All new schema fields are optional or defaulted; no config version bump is needed. If a bump becomes necessary, add a migration in the config loader.
- Persisted-key rules from `docs/archived_v1/RENAME_PLAN.md` apply (Stewart names only).
- Catalog data is read-only bundled JSON; the user can override a model's price via `agent.price`.

## Milestones (each independently shippable, each with positive + negative tests)

| # | Scope | Key tests |
|---|---|---|
| 1 | `ModelPerf` type, bench probes, probe cache and `modelCaps.perf` persistence, wizard opt-in | probe success; timeout leaves undefined; cached hit; bad JSON; old YAML loads |
| 2 | `catalog.ts` and data, price prefill, `costTier` | known and unknown model; user price wins; OpenRouter live price wins |
| 3 | Extended `ROLE_PROFILES`, scoring terms, `SetupContext` and protocol field, AI-evaluator prompt table, reasons text | filters on measured reliability; unknown not penalised as zero; priorities reorder results; AI pick failing hard rules dropped |
| 4 | `resolveLimits`, `budgets` settings, model factors, call-site swap | clamp bounds; unlimited preserved; unknown speed = 1; `maxRunHours` ceiling wins |
| 5 | `classifyTask`, workspace sizing, `/quick` `/deep` overrides, badges | the three example prompts; override precedence; scan caps respected |
| 6 | Escalation quick -> normal -> deep, log lines, docs (needs the v1 continue-question/split port, see B4) | auto-escalate once only; no de-escalation; split skipped in quick |

Order: 1, 2 and 4 are independent and can go in parallel; 3 needs 1-2; 5 needs 4; 6 needs 4-5 plus the fault-recovery port.

## Docs to update when building

`docs/SETUP.md` (engine inputs, protocol), `docs/FAULT_RECOVERY.md` (profiles and escalation, settings table), `docs/PROGRESS.md` (milestone rows), `AGENTS.md` References (add this file), `docs/DEBUG_LOGGING.md` (new log tags).

## Open questions

1. Should bench results be shared across projects (user-level cache) or per-workspace config? Suggested: user-level cache, copied into config on Apply. Yes.
2. Is a bundled price catalog acceptable to maintain? If not, A2 reduces to "prefer live provider pricing, else ask in the wizard". Yes use bundled price catalog.
3. Should `/quick` and `/deep` also select a cheaper or stronger agent for the role, or only change budgets? Suggested for v1: budgets only. It should change the agent strength and cost.
4. Default reference values (`refTokPerSec = 40`, cost reference, multipliers) are guesses; tune them after a few real runs. Acceptable.

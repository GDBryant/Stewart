# Deep-thinking divert: effort wiring + capability-aware escalation + wizard step

Status: **implemented** (2026-11-25; M1–M3 built; M4 was the final repository-gate verification milestone). Durable as-built summary: `docs/ai_docs/ARCHITECTURE_NOW.md` §§3a/3b/5 and `docs/ai_docs/PROGRESS.md`. The audited v2 plan below is retained for design context.

## Problem

1. **The looping agent is `lead`** (`~/.config/stewart/roles.yaml`): primary `AIF-qwen3-8-27b`, secondary `claude-sonnet`. When it loops, `LoopGuard` trips and the run ends (`modules/engines/src/nativeLoop.ts:317-318`, `reason: "loop_guard"`).
2. **Escalation is static, not capability-aware.** `modules/session/src/taskRun.ts:280-310` (`tryAgent`/`runChain`) moves to the *next agent in the role chain*; `roleChainIds` (`modules/roles-skills/src/chain.ts:13`) is just `[agent, secondary]`. Nothing inspects model capability at divert time.
3. **The capability knob is dead.** `effort: low|medium|high|max` exists in config (`modules/config/src/schema.ts:68`, inline anonymous enum, every agent set to `medium`) but **no provider request carries it**:
   - Claude path: the claude channel's `chat()` throws by design (`modules/channels/src/claude/adapter.ts:120-122`); all Claude work runs through the Claude **CLI engine**, whose argv (`modules/engines/src/claudeLines.ts:21-33`, `claudeArgv`) never sets effort.
   - Native path: `ChatRequest` (`modules/channels/src/types.ts:13-28`) has only `model, messages, tools, temperature, maxTokens, think, minNumCtx, responseSchema`. `EngineTurn` (`modules/engines/src/types.ts`) has only `think`.
4. **The only live reasoning control** is `think: boolean` — role → `taskRun.ts:175` → `EngineTurn.think` → `nativeLoop.ts:54-58` (`retryOpts`) → `ChatRequest.think` → Ollama body (`modules/channels/src/ollama.ts:131-139`). It is a disable-switch, and it only affects Ollama.
5. **Key discovery:** the installed Claude CLI supports **`--effort <level>` (low, medium, high, xhigh, max)** — verified via `claude --help`. "Deep thinking" on Claude is a one-argv-flag feature, not a request-schema feature.

Capability data for ranking already exists and is **already visible to session**: `Channel.probeCaps()` reports `reasoning: boolean` + `contextTokens` (Claude static: `adapter.ts:114-117`; Ollama: `reasoning: caps?.includes("thinking")` at `ollama.ts:120`), cached in `core.probeCache` (`packages/core/src/core.ts:37`) and **merged into `cfg.channels[].modelCaps` by `applyProbes`** (`packages/core/src/handlers/util.ts:63-72`). `runTask` already reads `deps.config()` (`taskRun.ts:316`) — no new plumbing needed to see caps.

## Architecture constraints (verified — these shape every part below)

| Constraint | Evidence | Consequence |
|---|---|---|
| `channels` has **5 deps, ratchet 5/5**: kernel, diagnostics, models, catalog, business-policy | `modules/channels/package.json:24-30`; `scripts/deps.baseline.json` `channels: 5` | **Must not** import `@stewart/config`. `ChatRequest.effort` uses a **local** union type |
| `engines` already imports config (7/7) and channels | `modules/engines/src/types.ts:2-3`; baseline `engines: 7` | `EngineTurn.effort` can be typed with config's `Effort` |
| `session` already imports config/roles-skills/channels (13/13) | `taskRun.ts:1-9`; baseline `session: 13` | divert wiring + settings read need no new edges |
| `roles-skills` already imports config (2/2) | `chain.ts:1`; baseline `roles-skills: 2` | `effectiveEffort` helper adds no edge |
| **`core` imports `session`** (`core.ts:13`) | `packages/core/src/core.ts:14` | **v1's "caps helper in packages/core" is a cycle — deleted.** session reads caps via `deps.config()` only |
| `taskRun.ts` = 347 lines, `nativeLoop.ts` = 352 (warn >300, fail >500) | `wc -l` | Both are **frozen for growth**: changes to them must be ~net-zero lines; divert logic lives in a **new file** |
| Webview talks protocol-only; wizard apply writes `agents.yaml`+`roles.yaml` | `packages/webview/package.json:12-16`; `SetupWizardModel.ts:63-74` | Part 3 needs a **settings-write** protocol path (named below) |
| Config files are channels/agents/roles/settings/project only | `modules/config/src/schema.ts:125-137` | `escalation` lives in **settingsSchema** |

**Net: zero new dependency edges. No `pnpm check:layers --update` needed. Any item that would add an edge is a review reject.**

## Part 1 — Wire `effort` end-to-end (root fix)

Precedence: **role override → agent value → "medium"**.

### 1a. Config — `modules/config/src/schema.ts`
- **Extract** the inline enum (line 68) into `export const effortSchema = z.enum([...])` + `export type Effort`. The enum is anonymous today; "reuse" in v1 was impossible.
- Add `effort: effortSchema.optional()` to `roleSchema` (optional = "inherit from agent").
- Check `roleMigrate` passes the new optional field through; existing role files must load unchanged (fields at `schema.ts:76-93` are untouched).
- New helper in `modules/roles-skills/src/chain.ts` (or a small sibling file, chain.ts is 78 lines — fine): `effectiveEffort(role: RoleDef, agent: AgentDef): Effort` = `role.effort ?? agent.effort ?? "medium"`. No new edges.

### 1b. Engine plumbing (Claude CLI)
- `modules/engines/src/types.ts`: `effort?: Effort` on `EngineTurn` (next to `think`, ~line 47) — engines→config edge exists.
- `modules/session/src/taskRun.ts` `attempt()`: add `...(eff !== undefined ? { effort: eff } : {})` to the turn object, `eff = effectiveEffort(spec.role, agent)`; if a Part 2 divert override is active, that wins (see 2c). **Keep net line count ~0** (file is at 347).
- `modules/engines/src/claudeLines.ts` `claudeArgv`:
  ```ts
  if (turn.effort && turn.effort !== "medium" && turn.channel.effortSupport)
    a.push("--effort", turn.effort);
  ```
  `medium`/undefined → omit (CLI default = medium; zero behavior change for existing config).
- **Capability probe, done in the claude adapter, not in argv code.** Precedent exists for spawning the CLI: `auth status` probe (`modules/channels/src/claude/adapter.ts:59-81`). Extend it: run `claude --help` once per channel (via the existing `SpawnFn`), detect `--effort` tolerantly, expose as `effortSupport: boolean` alongside `probeCaps` results (e.g. in the caps record or a cached field on the adapter). `claudeLines.ts` (125 lines) only *reads* `turn.channel.effortSupport` — it never spawns.
  *Unverified: exact help string — tolerant `--effort` search, unit-test the parser with fake help output.*

### 1c. Native (Ollama) path
**`think` stays — it is not made redundant by `effort`.** `think` is the on/off switch and the Ollama wire; `effort` is a *depth* scale (low→max) that rides on top of it and degrades to on/off on providers without granular reasoning (Ollama: high/max ⇒ `think: true`; `low` is a no-op). `effort: low` is still "think a little" — it has no "off" position, so `think: false` remains the only hard off (the retry path at `nativeLoop.ts:54-58` depends on it). Precedence: `think === false` wins over any effort; `effort: high|max` turns the switch on only when `think` is unset. Document this split in ARCHITECTURE_NOW so a future reader does not "refactor out" `think` as dead code.
- `modules/channels/src/types.ts`: `effort?: "low" | "medium" | "high" | "max"` on `ChatRequest` — **local union, not config's `Effort`** (channels must not import config, see constraints). Structurally identical, zero edges. Doc comment: "provider reasoning hint; `think` remains the explicit off-switch".
- `modules/engines/src/nativeLoop.ts` (352 lines, **frozen for growth** — ≤5 added lines): `streamModel`'s req build (~line 66) passes `effort: turn.effort`; `retryOpts` (~54-58) drops effort when a retry forces `think: false` (off-switch wins; matches existing retry shape).
- `modules/channels/src/ollama.ts` body (~131-139):
  - `think: req.think ?? (req.effort === "high" || req.effort === "max" ? true : undefined)` — `req.think === false` stays a hard off.
  - For high/max, floor the window: use `Math.max` semantics, but **note the user-pinned `numCtx` override** (`ollama.ts:131`): a user-set value wins — document this instead of fighting it. `low` is a no-op.
- Claude HTTP `complete()`/probe paths: **out of scope** — they inherit medium; document in ARCHITECTURE_NOW.

### 1d. Tests (M1 check)
- `modules/engines`: `claudeArgv` includes `--effort high` for high-effort turn + `effortSupport`; omits for medium/undefined/unsupported; `retryOpts` drops effort when retry forces `think: false`.
- `modules/channels`: Ollama body `think: true` for effort high; `undefined` for medium; `think: false` wins over high.
- `modules/config` + `modules/roles-skills`: `effortSchema` export; role `effort` parses; `effectiveEffort` precedence (role > agent > medium).
- Command: `cd modules/engines && ./node_modules/.bin/vitest run && cd ../channels && ./node_modules/.bin/vitest run && cd ../config && ./node_modules/.bin/vitest run && cd ../roles-skills && ./node_modules/.bin/vitest run`

## Part 2 — Capability-aware divert on loop trip

When a run trips the loop guard, switch to the **strongest reasoning-capable available agent** (or the user-configured one), **at most once per run**.

### 2a. Capability lookup — no new module needed
`runTask` already calls `deps.config()` (`taskRun.ts:316`), and `applyProbes` has merged probe results into `cfg.channels[].modelCaps` (`handlers/util.ts:63-72`). Build the caps accessor **inside the new divert file** from that config snapshot: key `channel.id + ":" + model` → `ch.modelCaps[model]`, read `reasoning`/`contextTokens`. Stale/absent → treat as unknown (ranked last). No TTL/re-probe path exists in `probeCache` and none is added here — document in ARCHITECTURE_NOW.

**Channel coverage caveat:** only claude-cli (static `reasoning: true`) and ollama (capability-driven) report `reasoning`; `openai-compatible` (`modules/channels/src/openai.ts:73`) never does → those agents rank "unknown" forever. Acceptable (documented), but "Auto" ranking must say so in the wizard UI.

### 2b. Selector — pure function, new location
`divertTarget` lives in **`modules/roles-skills/src/chain.ts`** (78 lines; or a sibling `divert.ts` if it pushes past 300 — expect <40 lines). Takes a `caps` callback → **no core import, no new edges**:
```ts
export function divertTarget(opts: {
  candidates: AgentDef[];      // all enabled agents except the tripping one
  tried: string[];             // agent ids already attempted this run
  current: AgentDef;           // the agent that just failed
  explicit?: string;           // settings escalation.onLoopGuard.agent (wins if eligible)
  channels: ChannelConfig[];   // for agentRefusal + channel-enabled checks
  role: RoleDef;               // for agentRefusal
  caps: (a: AgentDef) => { reasoning?: boolean; contextTokens?: number } | undefined;
  effort: (a: AgentDef) => Effort;   // effectiveEffort, for final tie-break
}): AgentDef | undefined
```
Ranking (first match wins):
1. `explicit`, if eligible.
2. `reasoning === true`, then higher `contextTokens`, then higher `effectiveEffort`, then stable config order.
3. No eligible candidate → `undefined` → `runChain` keeps today's static behavior (no regression).

**Eligibility** (corrected from v1 — `agentSchema` has no `enabled` field, `schema.ts:64-73`):
- `agentRefusal(role, candidate, channels) === null` (the real gate, `chain.ts:37-45`)
- candidate's channel `enabled`
- not in `tried`, not `current`
Cross-role agents are eligible (that's the point).

### 2c. Wiring — new file, taskRun stays frozen
- **New `modules/session/src/divert.ts`**: per-run state `divertUsed: boolean` + `divertEffortOverride?: Effort`; `maybeDivert(config, chain, tried, current, reason)` → calls `divertTarget` (imported from roles-skills, edge exists) and returns `{ next: AgentDef; effort?: Effort } | undefined`.
- `taskRun.ts` (~net-zero lines): in `runChain` (~301-309), on `tryAgent` failure with `ts.reason === "loop_guard"` and `!divertUsed`, call `maybeDivert`; on a hit prepend `next` to the remaining chain, emit `run.escalated` with `reason: "loop_guard_divert"` (existing event shape, `taskRun.ts:192-196`), and pass `divertEffortOverride` into `attempt`'s turn build (new optional param — one signature line). One divert per run, hard; if the target also fails, continue static chain as today.
- **`attempt()`'s effort param flows into the turn spread** (replaces the plain `effectiveEffort` call when present).

### 2d. Config field
`modules/config/src/schema.ts` → **`settingsSchema`** (`schema.ts:96-117`; config files are only channels/agents/roles/settings/project, `schema.ts:125-137` — `escalation` has no other home):
```ts
escalation?: z.object({
  onLoopGuard: z.object({
    agent: z.string().optional(),   // explicit divert target (Part 3 writes this)
    effort: effortSchema.optional() // override for the divert target's runs
  }).optional(),
}).optional();
```
Session already imports config — no edge.

### 2e. Tests (M2 check)
- `roles-skills`: `divertTarget` — explicit wins; reasoning-capable ranks above unknown; tripping agent excluded; refusal-excluded; `undefined` when nothing eligible.
- `session`: loop trip → divert to reasoning agent exactly once, `run.escalated` emitted with `reason: "loop_guard_divert"`, effort override reaches the turn; non-loop failures keep static behavior; no divert on second trip.
- `config`: settings escalation round-trips through loader.
- Command: `cd modules/roles-skills && ./node_modules/.bin/vitest run && cd ../session && ./node_modules/.bin/vitest run && cd ../config && ./node_modules/.bin/vitest run`

## Part 3 — Setup-wizard step: "Deep-thinking fallback"

### 3a. Step UI
- New `packages/webview/src/wizardStep4DeepThink.tsx`, registered in `SetupWizardSteps.tsx` (after Evaluator).
- Input: the wizard's existing `probeResults` (`wizardApply.ts` already takes them). List **reasoning-capable** agents first (caps from the same `modelCaps` data the apply flow already sees), with model, channel, contextTokens. Agents whose channel doesn't report `reasoning` (openai-compatible) are marked "capability unknown".
- Fields:
  - "When the primary model gets stuck (loop guard), hand over to:" — agent select; default = strongest reasoning-capable (same ranking as 2b); plus "Auto (best available)" (no explicit) and "Off".
  - "Effort for the hand-over agent:" — `low|medium|high|max`, default `high`.
  - Copy: "Deep thinking uses more tokens; the cost cap still applies."
- State: extend `SetupWizardModel.ts` (86 lines) + `wizardDerived.ts`; keep additions minimal or split a sibling file if >300.

### 3b. Persistence — the gap v1 missed
The wizard apply currently writes **exactly `agents.yaml` + `roles.yaml`** via `store.setupApply` (`SetupWizardModel.ts:63-74`; `wizardApply.ts:58-87` has no settings path). Part 3 must add:
1. **Core side:** a settings-write path — extend the existing setup-apply handler (grep `setupApply` in `packages/core/src/handlers/`) to also merge `escalation` into settings, or a sibling `setupApplySettings` handler registered on the protocol (check the protocol type in `packages/protocol`, webview's only import, `webview/package.json:12-16`).
2. **Webview side:** apply payload field (`escalation?: { agent?: string; effort?: Effort }`) + bridge call in `wizardApply.ts`.
3. "Off" / "Auto" → omit/undefined so Part 2's auto-ranking is the sole behavior.

### 3c. Visibility
`run.escalated` **already** renders `from → to: reason` (`packages/webview/src/stateHandlers.ts:123`) and `reason` is a free string — no protocol change; `loop_guard_divert` just reads as a distinct line. Optional: prettier label.

### 3d. Tests (M3 check)
- Webview: step render/selection; apply payload shape (escalation present for explicit, absent for Off).
- Config: settings escalation round-trip (covered in M2d; re-assert here).
- Command: `cd packages/webview && ./node_modules/.bin/vitest run && cd ../../modules/config && ./node_modules/.bin/vitest run`

## Milestones

| # | Work | Check (must exit 0) |
|---|------|--------------------|
| M1 | Part 1 (1a–1d) | `cd modules/engines && ./node_modules/.bin/vitest run && cd ../channels && ./node_modules/.bin/vitest run && cd ../config && ./node_modules/.bin/vitest run && cd ../roles-skills && ./node_modules/.bin/vitest run` |
| M2 | Part 2 (2a–2e) | `cd modules/roles-skills && ./node_modules/.bin/vitest run && cd ../session && ./node_modules/.bin/vitest run && cd ../config && ./node_modules/.bin/vitest run` |
| M3 | Part 3 (3a–3d) | `cd packages/webview && ./node_modules/.bin/vitest run && cd ../../modules/config && ./node_modules/.bin/vitest run` |
| M4 | Full gate | `pnpm -r typecheck && pnpm check:layers && pnpm check:boundaries && pnpm check:docs` (note: `taskRun.ts`/`nativeLoop.ts` are already over the 300 warn line — M1/M2 must not add lines to them; M4's boundaries check fails only >500, but keep the files flat) |

Per AGENTS.md hard rule: update `docs/ai_docs/ARCHITECTURE_NOW.md` (effort run path, divert run path, new settings fields, channel caps coverage caveat) and `docs/ai_docs/PROGRESS.md` **in the same commit as each milestone**.

## Audit corrections (v1 → v2, with evidence)

1. **[blocker] `ChatRequest.effort` must not import config's `Effort`.** channels has 5 deps, ratchet 5/5 (`package.json:24-30`; `deps.baseline.json`) — a 6th fails `check:layers`. → Local union in channels (1c).
2. **[major] "Reuse the existing enum" was impossible** — it's inline/anonymous (`schema.ts:68`). → Extract first (1a).
3. **[blocker] v1's "caps helper in packages/core" was a cycle** — `core` imports `session` (`core.ts:13`); no module may import core. → Deleted 2a; caps come from `deps.config()`'s already-merged `modelCaps` (`handlers/util.ts:63-72`).
4. **[major] `escalation` had no schema home** — config files are channels/agents/roles/settings/project (`schema.ts:125-137`). → `settingsSchema` (2d).
5. **[major] `taskRun.ts` (347) and `nativeLoop.ts` (352) are already past the 300 warn line.** → Divert logic in new `modules/session/src/divert.ts`; both files frozen for growth (2c, 1c).
6. **[major] Wizard apply had no settings-write path** (writes only agents+roles, `SetupWizardModel.ts:63-74`). → Named in 3b.
7. **[minor] "enabled" eligibility was wrong** — `agentSchema` has no `enabled` field; the real gate is `agentRefusal` (`chain.ts:37-45`). → 2b.
8. **[minor] Cross-role risk was overstated** — `attempt()` uses the role's system/tools/roleId (`taskRun.ts:164-175`); a cross-role divert is a model swap inside the same role. Residual risk: qualification (see 2b) + billing.
9. **[minor] Divert `effort` override had no plumbing** — `attempt` takes no effort. → New optional param (2c).
10. **[minor] CLI probe must live in the claude adapter** (spawn precedent `adapter.ts:59-81`), not in `claudeLines.ts`. → 1b.
11. **[minor] Ollama user-pinned `numCtx` wins over any floor** (`ollama.ts:131`) — documented, not fought.
12. **[nit] `run.escalated` rendering already exists** (`stateHandlers.ts:123`); reason is a free string.

## Risks / open questions

1. **Old Claude CLI versions without `--effort`** — help-probe guard (1b); worst case = today's behavior. *Unverified: which CLI version added the flag — probe, don't hardcode versions.*
2. **`xhigh`** exists in the CLI enum but not Stewart's — deliberately not added; mapping is identity for `low/high/max`.
3. **Cost:** high/max + diverts spend more tokens; existing `costCapped` stop (`taskRun.ts:288`) still applies.
4. **Ollama `think` is binary** — effort high/max ≈ enable thinking; no granular budget.
5. **openai-compatible agents are invisible to ranking** (no `reasoning` in caps, `openai.ts:73`) — "Auto" may pick them over nothing; UI marks them.
6. **Probe staleness:** `probeCache` has `probedAt` but no TTL/re-probe path; divert treats absent-`reasoning` as unknown. Document in ARCHITECTURE_NOW; no re-probe hook added in this plan.

## Out of scope

- `LoopGuard` thresholds/retry behavior (`nativeLoop.ts:29-98`).
- Anthropic `thinking.budgetTokens` over HTTP — CLI `--effort` covers the only live Claude path.
- Effort for probe/qualify/evaluator agents — they stay `medium`.
- **Adding any new module dependency edge** — see constraints table; a review reject if proposed.

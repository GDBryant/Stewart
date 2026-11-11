# Architecture Improvements (plan)

Status: **proposed**, 2026-11-11, baseline `d86ed9b` (v2.1.2). Current state: `../ai_docs/ARCHITECTURE_NOW.md`. Refactor rules: `REFACTORING.md`.

Rules for every step:
- One commit per step, with behaviour unchanged unless the step says otherwise.
- `ARCHITECTURE_NOW.md` is updated in the same commit.
- New modules go through `node scripts/new-module.mjs`, then `layers.json`, then `node scripts/sync-tsrefs.mjs`.
- The coverage gate (90% line / 80% branch) passes from the module's first commit.
- Every step ships positive and negative tests.

Order: **D** (docs) → **F** (file size and fan-out gates) → **C** (contracts and ownership) → **P** (feature plugins) → **M** (model caps) → **S** (setup channels).

## Module granularity (re-evaluation of the "too many modules" point)

Small modules are deliberate: one module per concern, one purpose per file. Merging them is **dropped**.

Two problems remain:
1. **File size is only enforced in `packages/core/src`.** `check:boundaries` applies `maxLines: 300` to core only. MODULAR_DESIGN step 8, which extends it, is deferred. Seven files are over 300 lines today:

   | File | Lines |
   |---|---|
   | `webview/SetupWizardSteps.tsx` | 380 |
   | `webview/App.tsx` | 375 |
   | `setup/probe.ts` | 351 |
   | `orchestration/orchestratedRun.ts` | 344 |
   | `channels/claude/parser.ts` | 316 |
   | `code-health/scan.ts` | 314 |
   | `setup/session.ts` | 301 |

   None is over 500.
2. **Some modules depend on too many others.** `runs` depends on 18 `@stewart` packages, and `orchestration` and `agent-loop` on 16 each. Much of that comes from type-only imports of contracts parked in the wrong module (see C1). This dependency spread, not the number of modules, is the real coupling cost.

## D. Docs current and checked (#6)

**Problem**
- `ARCHITECTURE_NOW.md` says version 2.2.0; the real version is 2.1.2.
- Its "Last updated" line is a changelog paragraph.
- Its header calls archived docs "current plans".
- §1 `modules/` is one unreadable paragraph.
- `ARCHITECTURE_REFACTORING.md` and the AGENTS.md index both say "proposed", but R1 and R2 are done and R3 is partial.

**Steps**
1. Fix the version, the header pointers and the refactoring status (R1 ✔, R2 ✔, R3 partial: recovery and bench are not wired). Replace "Last updated" with the date plus "see `git log -- docs/ai_docs/ARCHITECTURE_NOW.md`".
2. Rewrite §1 `modules/` as a table with columns module, layer, purpose (one line) and key files. Move the long detail into each module's `README.md`.
3. Add `scripts/check-docs.mjs` (and wire it into CI):
   - the version in `ARCHITECTURE_NOW.md` equals `hosts/vscode/package.json`;
   - every `layers.json` module has a row in the §1 table, and the table lists no module that doesn't exist.

**Tests:** check-docs passes on the fixed doc. It fails when the version is wrong, a module row is missing, or the table lists an unknown module.

## F. File size and dependency gates (re-evaluated #1)

**Steps**
1. Extend `check-boundaries.mjs` from core to every `modules/*/src`, `packages/*/src` and `hosts/*/src` (`.ts`, `.tsx`, `.kt`):
   - over 300 lines is a **warning**;
   - over 500 lines is a **failure**;
   - the current offenders are listed in the baseline, and only new violations fail.
2. `check-layers.mjs --report` prints each module's `@stewart` dependency count. Ratchet: a module's count may not grow without a baseline update.
3. Split the over-300 files:

   | File | Split |
   |---|---|
   | `orchestratedRun.ts` | fixed by P2 (the health code leaves) |
   | `session.ts` | fixed by S1 (draft channels go to a new file); also move draft load/save/expiry into `draftStore.ts` |
   | `probe.ts` | drain and in-flight tracking → `probeDrain.ts` |
   | `claude/parser.ts` | block-kind maps → `parserBlocks.ts` |
   | `scan.ts` | per-function metric walk → `scanFunctions.ts` |
   | `SetupWizardSteps.tsx` | one file per step |
   | `App.tsx` | `ChatView` and `MessageItem` → own files |

**Tests:** fixtures at 301 lines (warns), 501 lines (fails) and 499 lines (passes). A dependency count above the baseline fails.

## C. Contracts and ownership (#3)

### C1. `run-contract` module
**Problem:** `agent-loop/runtime.ts` holds the run contract: `RunRuntime`, `RoleTaskDeps`, `TaskResult`, `Recovery`, `RecoveryState`. Nothing inside agent-loop uses it (only `api.ts` re-exports it), yet it is the only reason agent-loop depends on `scheduling`, `run-state` and `interaction`.

**Layer constraint:** `check-layers` requires strictly lower layers. `runtime.ts` imports `ApprovalDecision` (from `loopTypes.ts`) and `FaultKind` (from `faults.ts`), both in agent-loop (layer 6). Moving those two types down keeps the new module at layer 6 with no renumbering.

**Steps**
1. Move `ApprovalDecision` and `ApprovalGate` → `permissions` (L3). Move `FaultKind` → `kernel` (L0, new `faults.ts`). Update the imports.
2. Create the `run-contract` module (L6) and move `runtime.ts` into it.
   - Retarget imports in orchestration, recovery, runs and `core/handlers/chat.ts`.
   - Drop `scheduling`, `run-state` and `interaction` from agent-loop's dependencies.
   - Drop the `RunRuntime = OrchestrationRuntime` alias and keep one name, `RunRuntime`.

**Done when:** `run-contract` exists, agent-loop has 13 dependencies, and `check:layers` and `check:cycles` pass.

### C2. One `Config` name
**Problem:** both `@stewart/config` and `@stewart/roles-skills` export a type named `Config`. `effective.ts` does belong in roles-skills (skills and role validation sit above config), but the shared name hides which one a caller gets.

**Step:** rename the roles-skills type to `EffectiveConfig` and its loader to `loadEffectiveConfig`, then update all importers.

**Tests:** typecheck everything. An `effective.ts` test confirms role-validation errors are merged in.

### C3. `v1-import` module
**Problem:** legacy XML import (`config/v1import.ts`, about 230 lines) sits inside `config`, though it has one caller (`core/handlers/config.ts`).

**Step:** create the `v1-import` module (L3, depends on `config`) and move `v1import.ts` into it. `config` no longer exports `importV1Xml`. The goal is that the module can be deleted later without touching `config`.

**Tests:** the existing v1import tests move unchanged. `config` api has no `importV1Xml`.

## P. Feature plugins: health check out of the generic layers (#2)

**Problem:** the code-health feature is wired into generic code in six places:
- `orchestration/tools.ts`: the `submit_health` and `health_report` verbs;
- `orchestratedRun.ts`: the `healthReports` map, the `isHealthCheckRequest` gate and `measureReportFiles`;
- `orchestrator.ts` `ORCHESTRATOR_DEFAULT_TOOLS` (includes `health_report`);
- the roleRunner `TERMINAL` set (includes `submit_health`);
- `config/loader.ts` `REQUIRED_ROLE_TOOLS`;
- `tools`: `codeMetrics.ts` and `fsRead.ts`, which import `isSourceFile` from `@stewart/code-health`.

**Target (in `run-contract`):**
```ts
interface RunFeature {
  id: string;
  /** Tools added for orchestrator roles or task roles; tools in `terminal` end the turn. */
  tools(scope: "orchestrator" | "task", ctx: FeatureRunCtx): Tool[];
  terminal?: string[];
  /** Tools always granted to these roles; config unions them into stale roles.yaml. */
  requiredRoleTools?: Record<string, string[]>;
  /** Refuse or annotate a run before planning, e.g. "code-health-reviewer not enabled". */
  preflight?(userText: string, rt: RunRuntime): { error: string } | undefined;
  /** Per-run state. Created once per run; the tools above close over it. */
  createRun(rt: RunRuntime): FeatureRunCtx;
}
interface FeatureRunCtx { tasks(): { id: string; roleId: string }[] }
```
`RunRuntime` gains `features: RunFeature[]`. Core builds the list; `runs` passes it through without importing any feature.

**Steps**
1. Add `RunFeature` to `run-contract`. Orchestration reads `rt.features`:
   - tool lists = the generic verbs + the feature tools;
   - the `TERMINAL` set = the generic set + feature `terminal`;
   - `preflight` runs before planning.

   No feature exists yet, so behaviour is unchanged.
2. Create the `health-check` module (L7, depends on `run-contract`, `tools`, `code-health` and `kernel`).
   - Move into it: `submit_health`/`health_report`, the reports map, aggregation and the scratch write, `measureReportFiles`, the preflight gate, and `CodeMetrics`.
   - Remove all `HealthReport` and `code-health` imports from orchestration. orchestration drops its `code-health` dependency.
   - Core registers `healthCheckFeature`.
3. Move `isSourceFile` → `kernel`. `ListCodeFiles` stays in `tools`, which is generic inventory; tools drops its `code-health` dependency.
4. Replace the `REQUIRED_ROLE_TOOLS` constant in `config` with a `loadConfig(…, required)` parameter. Core passes the union of each feature's `requiredRoleTools`, so existing user `roles.yaml` files keep their health tools.

**Tests**
- Positive: a health run produces the same report and scratch file as today (existing tests move to `health-check`); a fake feature's tool and terminal verb are dispatched and end the turn; preflight refuses the run when the reviewer role is missing.
- Negative: with no features, the orchestrator tool list is the generic list and `health_report` is unknown; a feature tool scoped `"task"` never reaches the orchestrator; `required` is empty when there are no features.

**Done when:** `grep -r "health" modules/orchestration/src` finds no matches, `orchestratedRun.ts` is under 300 lines, and neither orchestration nor tools depends on `code-health`.

## M. Model caps read only through `models` (#4)

**Problem:** six places still read `channel.modelCaps?.[model]` directly and pick their own default. Schema, type and write sites are legitimate and stay.

| Site | Reads |
|---|---|
| `channels/registry.ts:75` | `vision` |
| `channels/ollama.ts:118` | `numCtx` |
| `orchestration/roleRunner.ts:122` | `imageGen` |
| `orchestration/replacements.ts:18` | `contextTokens` (via an `as` cast) |
| `setup/bench.ts:151` | `tools` |
| `core/handlers/setup.ts:189` | `perf.benchVersion` |

**Steps**
1. Add `capsFor(cfg: { modelCaps?: … }, model): ModelCaps` to `models/caps.ts`. It merges with `DEFAULT_CAPS` and is used by `profileFromChannel`. Switch the two channels sites, `bench.ts` and `handlers/setup.ts` to it.
2. `roleRunner` uses the `profile` that `createAgentSession` already returns. `replacements.ts` uses `resolveModelProfile` and drops the cast.
3. Guard: a `check-boundaries` forbidden pattern `modelCaps\??\.\[` that fails outside `modules/models`, `modules/config` and `modules/v1-import`.

**Tests:** `capsFor` returns the user value over the default, and returns `DEFAULT_CAPS` for an unknown model or a missing map. The guard fails on a fixture containing a raw read and passes on `capsFor`.

## S. Setup owns its channels (#5)

**Problem:** the wizard's `addChannel` (`webview/wizardDerived.ts:68`) writes `channels.yaml` straight away through `store.saveFile`. That bypasses `SetupSession`:
- there is no review;
- cancel does not remove the channel;
- undo misses the change.

Probes need the channel before approval, which is why it is written early. `SetupDraft` already has `channels`, `reusedChannels` and `secretsCreated`, and cancel already deletes the secrets the session created. Out of scope: the Settings view's `channelExtra.tsx` `moveToStore` direct edit, which is a settings edit, not setup.

**Steps**
1. New `setup/draftChannels.ts` (keeps `session.ts` under 300 lines):
   - `addChannel` and `removeChannel` on the draft;
   - the secret ref goes into `secretsCreated`;
   - ids are validated (unique, non-empty).
2. `ChannelService.withOverlay(draftChannels)` returns a read-only service: the live channels plus transient draft channels. Setup probe and recommend use it while a session is active.
3. Add the protocol methods `setup.session.addChannel` and `setup.session.removeChannel`. Wire them in VS Code `routes.ts` and in the **JetBrains `WebviewRouter.kt` allowlist** (line 66).
4. The wizard calls the new methods instead of `saveFile`. `approveAndSave` writes the draft channels with the other files, so they are covered by backup, restore and undo.

**Tests**
- Positive: an added channel is probed, then written on approve; undo removes it.
- Negative: on cancel, there is no `channels.yaml` change and the secret is deleted; a duplicate or empty id is rejected; overlay channels never appear in `ChannelService` after the session ends; the JetBrains router forwards both new methods (Kotlin test).

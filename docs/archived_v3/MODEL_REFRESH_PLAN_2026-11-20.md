# Model refresh — agent reconcile with user prompts (2026-11-20)

## Intent
A channel's model list drifts (new provider models, pulled/removed Ollama models) and channels go temporarily unreachable (network, Ollama container down). A user-triggered refresh re-discovers models per channel and reconciles `agents.yaml`, asking the user what to do about each change. Chosen approach: explicit pull + question cards (option 1 from the 2026-11-20 investigation). Nothing is added or removed without a button click; unreachable is never treated as "models gone".

## Current state
- Agents are config rows (`agents.yaml`): `{id, channel, model, effort, temperature, billing, price, costs}`. `config.agents` is the registry; `core.reload` re-reads it.
- Live discovery is `ManagedChannel.listModels()` — called only from setup paths (`channel.test`, `benchCandidates`, `recommendAssignments`, `setup.probe`). Adapters already union `extraModels`.
- Agent minting exists only webview-side: `buildAgentsForRoles`/`agentForPair`/`uniqueAgentId` (`packages/webview/src/wizardApply.ts`).
- Removal machinery: none. `agentRefusal` never checks whether the model is still listed.
- User prompts already exist end-to-end: `Interaction.ask(questionPrompt(topic, text, options))` → `ask_user` RunEvent → `QuestionCard` buttons → `chat.answer` → `resolveAnswer`. Questions are per-`ProjectCtx`, FIFO, no timeout unless given one.
- File mutation pattern: `handleRolesAssignAgent` (`handlers/config.ts:116`) — parse `ctx.userLayer[file]`, mutate items, `userGuard.recordWrite` + `userConfig.write`, `core.reload`.

## Flow — `models.refresh` handler
New `packages/core/src/handlers/models.ts`, registered in `core.ts` as `"models.refresh"`. One refresh per project at a time (in-flight flag on `Core`; a second call returns `{ok:false, error:"refresh already running"}`).

1. **Discover.** For each enabled channel: `channelService.get(id)?.listModels()` wrapped per channel — success → `listed = [...new Set([...models, ...extraModels])]`; throw → `unreachable`. Disabled channels are skipped entirely (no questions, agents untouched).
2. **Diff** (pure, `diffModels`): per reachable channel `added = listed − agentPairs`, `gone = agents where a.channel === id && !listed.has(a.model)`; per gone agent, the role ids bound via `agent`/`secondary`.
3. **Ask** — sequential `await ctx.interaction.ask(questionPrompt("refresh", …))`, tag `runId: ids.next("sync")`, no `timeoutMs`. Order:
   - *Unreachable channel* with N bound agents: `"channel 'x' unreachable (<err>)"` → `[Keep, Retry once, Disable channel, Remove channel + N agents]`. Retry re-runs `listModels` once; on success the channel joins the normal diff.
   - *Added models* (>1 total): one batch question `"N new models found"` → `[Add all, Ask each, Skip all]`; `Ask each` → per model `[Add, Skip]`. (N=1 → just the per-model question.)
   - *Gone agent* `a` bound to roles `[r1, r2]`: `"model 'm' no longer listed on 'c' — remove agent 'a'?"` → `[Remove agent, Keep agent]`.
   - Withdrawn outcome (prompt cancelled, project closed) counts as keep/skip — never a destructive default.
4. **Apply** — one write pass after all answers, only if anything changed (`applyDecisions`, pure):
   - `agents.yaml`: drop removed agents; append minted `AgentDef`s.
   - `roles.yaml`: delete `agent`/`secondary` fields equal to removed agent ids (unbound → lead-chain fallback via `roleChainIds`).
   - `channels.yaml`: `Disable` → `enabled:false`; `Remove` → delete the item (its `modelCaps` quals go with it; the `secretRef` secret is left for the user to delete explicitly).
   - Write each touched file via `userGuard.recordWrite` + `userConfig.write` (watcher echo suppressed), then a single `core.reload`.
5. **Reply** `{ok, added:[agentIds], removed:[agentIds], disabledChannels, removedChannels, unreachable, error?}` → hosts reply `models.refresh.result`; webview then posts `config.get` to refresh summaries.

## Module changes
- `modules/setup/src/modelSync.ts` (new, exported via `api.ts`): pure `diffModels`, `applyDecisions`, `mintAgent({channel, model, channelType, catalog})`, `uniqueAgentId` — the same `ch-model` id, sanitize, dedupe-suffix and `billingFor` policy as `wizardApply.ts`. Webview keeps its own copy (`AgentSummary` shape; `@stewart/webview` only depends on `@stewart/protocol`), so the id/billing policy is duplicated by necessity — keep the two in lockstep.
- `modules/interaction/src/interaction.ts`: add `"refresh"` to `PromptTopic` (additive; `PromptView.topic` carries it for future styling).
- `packages/core`: `handlers/models.ts`, handler registration, `refreshInFlight` guard. Price for minted agents via existing `catalogFor` (`handlers/util.ts`).
- Protocol: no `RunEvent` changes — `ask_user` already carries `options`.

## Host + webview wiring
- `hosts/vscode/src/routes.ts`: `"models.refresh"` → `dispatchAndReply(..., {type:"models.refresh.result"})`.
- `hosts/jetbrains/.../WebviewRouter.kt`: `"models.refresh"` → `request()` + reply `models.refresh.result` (same shape as `channel.test`).
- `packages/webview/src/bridge.ts`: `Outbound` += `{type:"models.refresh"}`; `Inbound` += `{type:"models.refresh.result"; ok:boolean; added?:string[]; removed?:string[]; disabledChannels?:string[]; removedChannels?:string[]; unreachable?:string[]; error?:string}`.
- `state.ts`/`stateHandlers.ts`: `refreshModels()` posts it; result → patch a `refreshSummary` (or `lastError`) and post `config.get`.
- `SettingsView.tsx`: "Refresh models" button next to the channel/agent section; render pending `state.questions` as `QuestionCard`s inside Settings too (export `QuestionCard` from `ChatView.tsx` or extract to a shared file) — the same cards keep rendering in ChatView.

## Edges
- `extraModels` always count as listed → their agents never get "gone" questions.
- `Keep` on a gone model leaves the row; the next refresh re-asks (no suppression state).
- In-flight runs are safe: chains are resolved per task start; `core.reload` only affects new resolutions.
- `probeCache`/`priceCache` entries for removed models are left in place (keyed `channel:model`, harmless, drop on process restart).
- User-tuned fields on kept agents (effort, price, costs) are never touched — reconcile only adds rows or deletes whole rows.

## Tests (positive + negative)
- `modules/setup/test/modelSync.test.ts`: diff add/gone/extraModels/disabled-skip; `applyDecisions` unbinds `agent` and `secondary` correctly and leaves other roles; `mintAgent` id sanitization, `-2` suffix dedupe, billing per channelType (priced when catalog `inPerMTok > 0`, `reported` for claude-cli, `free` for ollama).
- `packages/core/test/modelsRefresh.test.ts`: scripted `interaction` answers over stubbed `channelService.listModels` — add-all path writes agents.yaml; unreachable→Keep writes nothing; unreachable→Remove channel writes channels.yaml + agents.yaml + roles.yaml unbind; unreachable→Retry success falls into normal diff; withdrawn → no write; second concurrent refresh rejected; empty diff returns ok with no writes and asks nothing.
- `hosts/vscode/test/routes.test.ts`: `models.refresh` posts `models.refresh.result` with spread result.
- `hosts/jetbrains` `WebviewRouterTest.kt`: same round-trip.
- `packages/webview` handler test: `models.refresh.result` → `config.get` posted and summary patched.

## Housekeeping
- Update `docs/ai_docs/ARCHITECTURE_NOW.md` in the same commit (`models.refresh` run path, `"refresh"` prompt topic, modelSync module).
- Add this doc's reference to `AGENTS.md`.

## Decisions
- Question cards land in the normal `ask_user` stream (chat + settings-rendered) — no new prompt surface.
- Removal is always per-decision, so no `source`/`managed` provenance field is needed in `agentSchema`.
- Sequential questions, batch-escape for adds; per-model removals are always individual (they carry role-binding context).

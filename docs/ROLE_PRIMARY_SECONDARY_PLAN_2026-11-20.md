# Role primary + secondary agent plan (2026-11-20)

Status: implemented.

## Problem

A role binds models through two fields: `agent` and `chain`. When `chain` is set, it wins (`roleChainIds`, `modules/roles-skills/src/chain.ts:13-21`). Settings only shows `agent` and keeps `chain` in a hidden csv field (`packages/webview/src/rolesSection.tsx:112-116`). Changing the agent in the drop-down leaves an old `chain` in place, so the role keeps running the old model.

Seen on 2026-11-20 in `~/.config/stewart/roles.yaml`: `reviewer` (agent `AI Factory-glm-5-3-flash`, chain `[local-ollama-ornith-1-5-9b]`) and `tester` (agent AIF, chain `[local-ollama-qwen3-5-4b]`) ran on Ollama. `task.started` and channel admission read `role.agent` (`modules/session/src/child.ts:210-212`), so the UI showed AIF while Ollama did the work, and Ollama's `maxParallel: 1` was not enforced for those tasks. `roles.assignAgent` (`packages/core/src/handlers/config.ts` `handleRolesAssignAgent`) has the same flaw: it sets `agent` and never touches `chain`.

## Target

Each role has at most two agents:

- `agent`: the primary agent (optional, as today: no agent means the role falls back to the lead's agents).
- `secondary`: the fallback agent. Optional. A blank secondary is valid and means "primary only, no escalation".

`chain` is removed from the schema, the UI, the protocol and the wizard. Runtime order is `[agent, secondary]`. Settings shows two drop-downs. What the UI shows is exactly what runs.

## Decisions (settled)

1. **Field names.** Keep `agent` as the primary, so the many existing readers and fixtures stay valid. Add `secondary?: string`. Do not rename to `primary`.
2. **Blank secondary.** `secondary` absent or `""` both mean none. Normalize `""` to absent on load and on save. The runtime chain is then `[agent]`.
3. **Secondary without primary.** It is ignored at runtime: the role inherits the lead's agents, as it does today with no agent. The UI makes this state impossible: clearing the primary also clears the secondary, and the secondary drop-down is disabled while the primary is blank.
4. **Secondary equal to primary.** Drop it (dedupe). The UI leaves the current primary out of the secondary options. If the user sets the primary to the current secondary, clear the secondary.
5. **Inheritance.** A role with no `agent` inherits the lead's full `[agent, secondary]`. A role with an `agent` never inherits the lead's secondary.
6. **Legacy `chain` migration** happens on load and is silent. A pure function `migrateRoleChain(raw: unknown): unknown` runs as a `z.preprocess` on `roleSchema`. This follows the existing `"shim"` preprocess precedent in `schema.ts:25`. `CONFIG_VERSION` is not bumped. The rules:
   - `chain` absent or empty: drop the key.
   - `agent` set and `chain[0] === agent`: `secondary ??= chain.find(id => id !== agent)`.
   - `agent` set and `chain[0] !== agent`: the chain is stale (this is the bug). Drop it and leave `secondary` unchanged.
   - `agent` unset: `agent = chain[0]`, `secondary ??= chain[1]` (when it differs).
   - Always `delete chain`. Chain entries beyond the second are dropped.
   - Settings saves the parsed summary (`RolesSection.save` serializes `RoleSummary[]`), so the next save writes clean YAML with no `chain`. The user's file is fixed by the first load plus any save. No migration write is needed.
   - For the user's current file: lead/explorer/planner get no secondary; reviewer/tester drop the stale Ollama chain and become AIF only.
7. **Compatibility with older plugin builds.** `secondary` is an unknown key to them, and zod strips it, so they run primary only. That is acceptable.
8. **Wizard.** It proposes a primary and at most one secondary. `ScoredAssignment.chain` and the protocol `chain` arrays become `secondary?: {channel, model}`. The review row's reorder/remove `ChainRow` is replaced by a second `<select>` with a blank option.
9. **Admission and labels** use the first eligible agent (`eligibleChain(...)[0]`), not `role.agent`. That way `task.started.agentId` and the admitted channel match what actually runs. Known gap, not fixed here: when a task escalates to a secondary on another channel, it keeps the primary's admission slot.

## Changes by file

### `modules/config` (layer: config)
- `src/schema.ts`: in `roleSchema`, replace `chain: z.array(z.string()).optional()` with `secondary: z.string().optional()`. Wrap the object as `z.preprocess(migrateRoleChain, z.object({...}))`. `RoleDef` stays `z.infer<typeof roleSchema>`. Check that nothing calls `roleSchema.shape` or `.extend` (only `versioned(roleSchema)` today).
- New `src/roleMigrate.ts`: `export function migrateRoleChain(raw: unknown): unknown`, implementing decision 6 plus the `""` → absent rule for `secondary`. Non-objects pass through unchanged. It must stay within the function limits (≤40 lines, complexity ≤10, depth ≤3); split it into `legacySecondary(agent, chain)` if needed. Export it through `api.ts` only if another module needs it (the evals do not: see below).
- `test/loader.test.ts`: change the `chain: [a1, a2]` case at :112-122 to `agent`/`secondary`. Add migration cases: consistent chain gives a secondary; stale chain is dropped; agent-less chain gives agent + secondary; a 3-entry chain is truncated; `secondary: ""` becomes undefined; no chain leaves the role unchanged; a non-object item still fails the schema.

### `modules/roles-skills`
- `src/chain.ts`:
  - `roleChainIds`: when `role.agent` is set, return `dedupe([role.agent, role.secondary].filter(Boolean))`. Otherwise use the lead's ids (recursion unchanged), otherwise `[agents[0].id]`. Update the doc comment.
  - `chainErrors`: ids = `role.agent ? [role.agent, role.secondary?].filter(Boolean)` deduped, else `[]`. An unknown primary is still reported by `validateRoles`. An unknown secondary gives `role X: unknown secondary agent 'id'`. A refused secondary gives `role X: agent 'id' <why>` (same text as today).
  - `chainEntryError`: take a `slot: "primary" | "secondary"` parameter instead of reading `role.chain`. Watch the 4-parameter limit.
- `src/roles.ts`: no logic change.
- `test/chain.test.ts`: rewrite the chain cases (:18-20, 40-121) to use `agent`/`secondary`. Add cases for: blank secondary → `[agent]`; secondary === agent → `[agent]`; secondary without agent → lead's ids; agent-less role inherits the lead's secondary; a role with an agent does not; unknown secondary error; refused secondary is filtered out by `eligibleChain` and reported by `chainErrors`.

### `modules/setup`
- `src/assign.ts`: change `ScoredAssignment.chain` to `secondary?: { channel; model }`. Replace `proposeChain` with `proposeSecondary(p, candidates, chosen)`: same filter and sort (`chainBucket`, then cost), returning the first ok candidate that is not `chosen`, else `undefined`. In `toAssignment`, drop `chain: []`. In `assignRoles`, set `secondary: proposeSecondary(...)`.
- Tests: update any `chain` expectations in `modules/setup/test` (run `grep -rn chain modules/setup/test`). Add: no other qualified candidate → secondary undefined; secondary is never equal to the primary; free/local candidates are preferred.

### `modules/session`
- `src/child.ts` `childAgent(role)`: return `eligibleChain(role, cfg.roles, cfg.agents, cfg.channels)[0] ?? this.d.agent` (import from `@stewart/roles-skills`, already a dependency through `functionTask.ts`).
- Test (`test/session.test.ts`): a child role with an `agent` refused by qualification and a qualified `secondary` emits `task.started.agentId === secondary` and admits on the secondary's channel. Also, the regression for the reported bug: a role whose `agent` is X emits `task.started` with X.
- Change the fixtures at `session.test.ts:1011, 1129, 1255, 1335`, `plan.test.ts:115` and `turnChecks.test.ts:178` from `chain: ["a1","a2"]` to `agent: "a1", secondary: "a2"`. The escalation tests at :1124 and :1254 must still pass unchanged otherwise.

### `packages/core`
- `src/handlers/config.ts` `handleRolesAssignAgent`: after `item.agent = p.agentId`, run `delete item.chain`, and `delete item.secondary` when `item.secondary === p.agentId`. Otherwise keep the secondary.
- Test: assigning to all removes a legacy `chain` from the written YAML, keeps a different secondary, and drops a secondary equal to the new agent.

### `packages/protocol` / bridge types
- `packages/webview/src/bridge.ts:54` `RoleSummary`: replace `chain?: string[]` with `secondary?: string`. At :150, change the assignment `chain?` to `secondary?: { channel; model }`.
- `packages/webview/src/stateTypes.ts:125`: same assignment change.
- Check `packages/protocol` and `packages/core` for a typed `setup.recommend.result` payload (`grep -rn "recommend" packages/protocol/src packages/core/src`) and change it the same way.

### `packages/webview`
- `src/rolesSection.tsx`:
  - In `RoleEditForm`, replace the `agent` field and the `chain (csv)` field with:
    - `<RoleAgentField label="primary agent" value={role.agent} candidates={candidates} onPick={(v) => save(primaryPatch(role, v))} />`
    - `<RoleAgentField label="secondary agent" value={role.secondary} candidates={candidates.filter((a) => a.id !== role.agent)} disabled={!role.agent} onPick={(v) => save({ secondary: v })} />`
  - `primaryPatch(role, v)` returns `{ agent: v, secondary: !v || v === role.secondary ? undefined : role.secondary, chain: undefined }`. Setting `chain: undefined` keeps any legacy key out of the saved YAML (yaml `stringify` omits undefined).
  - `RoleAgentField` gets an optional `disabled` prop. Its blank `—` option already maps to `undefined`: that is the blank secondary.
  - In `RoleCard`, the summary line becomes `agent: P` or `agent: P → S`. Keep the ChannelDot for the primary. Show the cost badge if either agent costs.
  - A saved secondary that is no longer a candidate (it lost qualification) must still show in the `<select>`. Add it as an option labelled `id (not qualified)` so the value is not silently blanked. The server's `chainErrors` already reports it in Settings.
- `src/SetupWizardModel.ts`: replace `chainEdits`/`chainFor`/`moveRef`/`onChainMove`/`onChainRemove` with `secondaryEdits: Record<string, string>` and `secondaryFor(role)`. `secondaryFor` returns the edit if present (`""` = user chose blank), else the recommendation's secondary ref, else `""`. It returns `""` when that equals `row(role)`. `apply` passes `secondaries: {role, ref}[]` (non-empty refs only).
- `src/wizardApply.ts` `buildAgentsForRoles`: change the input `chains?` to `secondaries?: { role: string; ref: string }[]`. Resolve or create agents for those refs as it does for the chosen ones. Each role gets `{ ...r, agent, secondary: pairToAgent.get(secRef), chain: undefined, enabled: true }`. Disabled roles also get `chain: undefined`.
- `src/SetupWizardResult.tsx`: delete `ChainRow`. In `ReviewRoleRow`, add a second `<select aria-label={`role ${role.id} secondary`}>` with an option `""` labelled `(none)` plus `options` minus the chosen ref. It is disabled when `chosen` is blank. Thread `secondary`/`onSecondaryChange` through `ReviewStep` props in place of `chainFor`/`onChainMove`/`onChainRemove`.
- `test/app.test.tsx`:
  - The :762 test picks the last `select` in the edit form. That is now the secondary, so target the primary by label (`getByLabelText("primary agent")`). Add an equivalent assertion for the secondary.
  - New tests for Settings: picking a primary writes `agent:` and no `chain:`; picking the secondary writes `secondary:`; choosing `—` for the secondary removes the key (blank allowed); clearing the primary clears the secondary and disables its select; setting the primary to the current secondary clears the secondary; the current primary is not offered as a secondary; a role loaded with a non-candidate secondary still shows it.
  - Wizard tests (:1355-1930): apply writes `secondary:` from the recommendation; picking `(none)` writes no secondary; the secondary select excludes the primary; the applied YAML never contains `chain:`.
  - Delete any `ChainRow` (↑/×) tests.

### `packages/evals`
- `src/qualify.ts:60-71` `RoleItem`: use `agent`/`secondary`. It reads raw YAML (no schema), so also accept legacy `chain` in `bound` so old configs still qualify: `[...(r.chain ?? []), r.agent, r.secondary].filter(Boolean)`. `test/qualify.test.ts:44`: add a `secondary` case and keep the legacy chain case.
- `configs/lead-chain-local/roles.yaml`: `chain: [local-qwen4b, Claude-sonnet]` → `agent: local-qwen4b`, `secondary: Claude-sonnet` (three roles).
- `configs/lead-chain-aif/roles.yaml`: the 4-entry anchored chain can no longer be expressed. Set `agent: local-qwen4b`, `secondary: AI Factory-glm-5-3-flash`, remove the anchor, and record in `docs/ai_docs/EVALS.md` that this config now escalates over 2 agents (older recorded pass rates used 4).

### Docs (same commit, per AGENTS.md hard rule)
- `docs/ai_docs/ARCHITECTURE_NOW.md`: lines 46 (`roles-skills` row: `kind`/`needs`/`agent`+`secondary`), 52 (setup: "secondary proposal"), 53 and 80 ("escalation from primary to secondary"), 104 (`delegate`: child agent = first eligible of `[agent, secondary]`, else the lead's), 112 (config files: legacy `chain` migrated on load).
- `docs/ai_docs/SETUP.md:8`: the review step offers a primary and an optional secondary drop-down; the secondary is the cheapest other qualified candidate.
- `AGENTS.md` References: mark this plan implemented when it is done.

## Build order (each step green on its narrow checks)

1. config schema + `migrateRoleChain` + loader tests. Check: `cd modules/config && ./node_modules/.bin/vitest run`.
2. roles-skills `chain.ts` + tests. Check: `cd modules/roles-skills && ./node_modules/.bin/vitest run`.
3. session `childAgent` + fixture updates. Check: `cd modules/session && ./node_modules/.bin/vitest run`.
4. setup `proposeSecondary` + protocol/bridge types + core `handleRolesAssignAgent`. Check: vitest in `modules/setup` and `packages/core`.
5. webview Settings role form + wizard. Check: `cd packages/webview && ./node_modules/.bin/vitest run`.
6. evals configs + qualify. Check: `cd packages/evals && ./node_modules/.bin/vitest run`.
7. Docs. Final gate, once: `pnpm -r typecheck && pnpm -r test && pnpm check:layers && pnpm check:boundaries && pnpm check:functions && pnpm check:docs && pnpm test:coverage`. Then re-bundle the sidecar and `./gradlew buildPlugin` (AGENTS.md commands).

## Acceptance
- No `chain` reference remains in `modules/*/src` or `packages/*/src` except `migrateRoleChain` and the evals `qualify.ts` legacy read: `grep -rnw chain modules/*/src packages/*/src`.
- Loading the user's current `~/.config/stewart/roles.yaml` gives reviewer/tester `eligibleChain` = `[AI Factory-glm-5-3-flash]`, and lead/explorer/planner gain no secondary. Add this as a loader + chain test fixture copied from that file.
- In Settings, a role shows two drop-downs. A blank secondary saves with no `secondary` key and runs primary only.
- `task.started.agentId` always equals the agent that runs first.

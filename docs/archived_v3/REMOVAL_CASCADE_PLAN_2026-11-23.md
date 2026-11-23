# Removal cascade plan (2026-11-23)

Status: implemented (v3.0.12). Owner split: **[L]** lead (design, review, commit), **[S]** delegated (build, tests, gates).
As-built deviations: a rename onto an id already in the list is also a rename (references merge onto it); unparseable user/project rows are read as empty (no cascade into a broken file).

## 1. Goal

- Channel removed → every agent on it is removed.
- Agent removed (in Settings, or by the channel cascade) → every role binding it is reset.
- Role reset rule (decided): clear the removed slot only. `secondary` removed → drop `secondary`. `agent` removed → surviving `secondary` is promoted to `agent`; none → role is unbound (inherits the lead's agent). All other role fields stay.
- Id rename in Settings (decided): not a removal; references are re-pointed.

## 2. Current state

| Path | Today |
|---|---|
| `models.refresh` (`handlers/models.ts` → `applyDecisions`) | Cascades already. `unbindRole` leaves an orphan `secondary` when `agent` is removed (ignored by `roleChainIds`). |
| Settings channel Remove (`config.set channels.yaml`) | Uncommitted WIP: `modules/setup/src/cascade.ts` `cascadeChannelRemoval`, wired in `handlers/config.ts`; `window.confirm` in `items.tsx`. No tests, no docs. |
| Wizard `setup.session.removeChannel` | Uncommitted WIP: `cascadeStagedFiles` in `draftChannels.ts`. No tests. |
| Settings agent Remove (`config.set agents.yaml`) | No cascade: roles keep the id → `unknown agent` config error. |
| Settings id edit (channel/agent) | Dangling references; with the WIP a channel rename would delete its agents. |

Facts the design relies on: channels/agents exist only in the user layer (shipped defaults carry `roles.yaml` only, no agent bound); roles merge defaults < user < project field-by-field, so a project `roles.yaml` binding survives a user-file unbind; `ItemsSection` saves the whole file with one item replaced in place.

## 3. Design

### 3.1 Pure (`@stewart/setup`)

`modelSync.ts` `unbindRole`: implement the reset rule above (untouched rows returned by identity). `models.refresh` inherits it.

`cascade.ts` (replaces `cascadeChannelRemoval`; exported from `api.ts`):

```ts
export interface IdChange { removed: string[]; renamed?: { from: string; to: string } }
/** Rename = exactly one id gone and one new, same length, same index. Anything else gone = removed. */
export function detectIdChange(prev: RawItems, next: RawItems): IdChange;

export interface CascadeResult { agents: RawItems; roles: RawItems; removedAgents: string[]; resetRoles: string[]; changed: boolean }
/** Agents on `channels` plus `agents` are removed; roles binding them are reset (via applyDecisions). */
export function cascadeRemoval(docs: Pick<SyncDocs, "agents" | "roles">, gone: { channels?: ReadonlySet<string>; agents?: ReadonlySet<string> }): CascadeResult;

/** kind "channel": agents' `channel` from→to. kind "agent": roles' `agent`/`secondary` from→to. */
export function repointRename(docs: Pick<SyncDocs, "agents" | "roles">, kind: "channel" | "agent", r: { from: string; to: string }): CascadeResult;
```

### 3.2 Core (`config.set`)

New `packages/core/src/handlers/configCascade.ts`: `cascadeConfigSet(core, ctx, file, doc): Promise<void>`; `handleConfigSet` calls it after `writeConfigLayer`, with `core.reload` in a `finally`. Runs only for the user layer and `channels.yaml` / `agents.yaml`. WIP helpers in `config.ts` move here.

- `prev` = items of `ctx.userLayer[file]`; `detectIdChange(prev, nextItems)`.
- `channels.yaml`: rename → `repointRename("channel")`, write `agents.yaml`. Removed → `cascadeRemoval({channels})`, write `agents.yaml` + `roles.yaml`.
- `agents.yaml`: rename → `repointRename("agent")`. Removed → `cascadeRemoval({agents})` with the incoming items as `docs.agents`. Write `roles.yaml` only.
- Docs are raw user rows (`[]` when the file is absent) — no materialized-defaults fallback, so shipped roles are never frozen into the user file.
- Project layer: when `ctx.trusted` and `ctx.projectLayer["roles.yaml"]` binds an affected agent, apply the same transform and write through `ctx.projectGuard.recordWrite` + `ctx.projectStore.write`. Current project only.
- Writes use `writeItems` (`handlers/util.ts`), only when changed.

### 3.3 Wizard

`removeDraftChannel` → `cascadeStagedFiles` calls `cascadeRemoval({channels: {id}})` on staged `agents.yaml`/`roles.yaml` (WIP kept, renamed call).

### 3.4 Webview

- Drop `window.confirm` (`askRemove`): VS Code webviews have no `allow-modals`. Inline two-step confirm in `ItemCardTitle`: Remove → message + `Confirm remove` / `Cancel`.
- New `removalImpact.ts`: `removalImpact(kind, id, agents, roles): { agents: string[]; roles: string[] }` (pure).
- Channels: always confirm, naming affected agents and roles. Agents: confirm only when a role binds it, naming the roles.
- No protocol or host change.

### 3.5 Non-goals

Hand-edited YAML (watcher reload keeps the existing `unknown agent` errors); deleting the removed channel's secret; project `roles.yaml` of other open projects; runs in flight.

## 4. Tests (positive + negative)

| File | Cases |
|---|---|
| `modules/setup/test/modelSync.test.ts` | `agent` removed + surviving `secondary` → promoted; `secondary` removed → dropped; both removed → unbound; unrelated role returned by identity; unknown fields kept. |
| `modules/setup/test/cascade.test.ts` (new) | channel removal drops only its agents and resets their roles; agent-only removal; unknown channel/agent id → `changed: false`, same arrays' rows; `detectIdChange`: rename, removal, remove+add at different index (= removal), two gone (= removals), no change; `repointRename` channel and agent, no match → unchanged. |
| `modules/setup/test/draftChannels.test.ts` | staged files lose the channel's agents and role bindings; no staged files → no-op; channel not added by the session → refused, staged files untouched. |
| `packages/core/test/configCascade.test.ts` (new) | `config.set channels.yaml` minus a channel → `agents.yaml` + `roles.yaml` rewritten, reloaded config has no role errors; `config.set agents.yaml` minus an agent → roles reset (promote case included), `agents.yaml` not rewritten; edit without removal → `agents.yaml`/`roles.yaml` byte-identical; channel rename → agents re-pointed, none removed; agent rename → roles re-pointed; no user `roles.yaml` → none created; trusted project `roles.yaml` binding reset; untrusted → project file untouched; `layer: "project"` → no cascade; cascade write failure still reloads. |
| `packages/core/test/modelsRefresh.test.ts` | Update for the promote rule. |
| `packages/webview/test/removal.test.tsx` (new) | `removalImpact` cases; channel Remove shows confirm, Cancel posts nothing, Confirm posts `config.set`; agent bound to a role confirms and names roles; unbound agent removes at once. |

## 5. Build order and delegation

1. **[L]** This plan; user approval.
2. **[S]** One handoff: §3.1–3.4 + §4 on top of the WIP in the tree. Verify narrowly: the vitest files above and `tsc --noEmit` in `modules/setup`, `packages/core`, `packages/webview`.
3. **[L]** Review the full diff; **[S]** one consolidated rework if needed.
4. **[S]** Docs + gates: `ARCHITECTURE_NOW.md` (new §3 "Removal cascade", §3e role rule), `SETUP.md` (`removeChannel` cascade), `PROGRESS.md`; patch bump via `pnpm version:set`; once: `pnpm check:layers check:boundaries check:cycles check:tsrefs check:docs check:functions`, `pnpm test:coverage`.
5. **[L]** Review, commit (docs in the same commit; no push), move this plan to `docs/archived_v3/` and update the `AGENTS.md` reference.

Limits to respect: functions ≤40 lines / ≤4 params / complexity ≤10; files ≤300 lines (`core.test.ts` is at 485 → new test file); coverage ≥90% line, ≥80% branch.

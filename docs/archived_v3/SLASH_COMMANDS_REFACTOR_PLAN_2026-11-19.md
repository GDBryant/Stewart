# Slash commands refactor plan (2026-11-19)

Status: proposed, ready for handover. Baseline: the uncommitted `/clear` work (`SessionService.clear`/`delete`, `chat.cleared {sessionId?}`) is committed first; this plan starts from that tree.

## 1. Problem

Slash commands live in one file, `modules/session/src/slash.ts` (185 lines): parser, registry, `/help`, `/init` (with its stub templates and prompt), `/clear`, and `runSlash`. Adding many commands hits these limits:

| # | Limit | Evidence |
|---|---|---|
| P1 | One file grows linearly; `check:boundaries` warns at 300, fails at 500 lines | `slash.ts` 185 lines with 3 commands |
| P2 | Each command that needs a session capability adds an optional hook to `SlashDeps` plus a wiring line in core | `clearSession?` in `SlashDeps`; `clearSession: (id) => ctx.sessions.clear(id)` in `packages/core/src/handlers/chat.ts` |
| P3 | Closed registry: a hard-coded array, no duplicate/alias check, no external sources | `export const SLASH_COMMANDS: SlashCommand[] = [...]` |
| P4 | No discovery for the webview: no protocol method lists commands, so no `/` autocomplete | `METHODS` in `packages/protocol/src/index.ts` has no slash method |
| P5 | Errors in `run` escape `runSlash` and reject `chat.send`; each command re-implements its own `try/catch` + message | `/init` and `/clear` each catch and format errors |
| P6 | Slash commands are not a session concern but live in `@stewart/session` and are re-exported from its `api.ts` | `api.ts` lines 6–7 |

Out of scope: changing what `/help`, `/init`, `/clear` do; the `//` escape; `chat.local` rendering.

## 2. Target design

### 2.1 New module `@stewart/slash`

Create with `node scripts/new-module.mjs slash "Slash command parser, registry and local commands"`, add `"slash": 3` to `scripts/layers.json`, fill `README.md`.

- Depends on: `@stewart/kernel`, `@stewart/interaction`, `@stewart/protocol` only. It must **not** depend on `@stewart/session`; session capabilities arrive through the port in 2.2.
- Depended on by: `packages/core` only.
- `@stewart/session` drops `slash.ts` and its `api.ts` re-exports (lines 6–7). `SessionService.clear` stays in session.

Layout:

```
modules/slash/src/
  api.ts            surface: parseSlash, slashPlainText, runSlash, createRegistry, builtinCommands, types
  types.ts          SlashCommand, SlashContext, SlashSessionPort, SlashCommandInfo
  parse.ts          parseSlash, slashPlainText (moved verbatim)
  registry.ts       createRegistry: duplicate/alias check, find, list
  run.ts            runSlash: parse → find → run, central error capture
  commands/
    index.ts        builtinCommands(): SlashCommand[]  (help, init, clear)
    help.ts
    init.ts         ensureInitFiles, INIT_* constants, stub templates
    clear.ts
modules/slash/test/
  parse.test.ts  registry.test.ts  run.test.ts  help.test.ts  init.test.ts  clear.test.ts
```

Rule for new commands: one file in `commands/`, one line in `commands/index.ts`, one test file. Nothing else changes unless the command needs a new session capability (2.2).

### 2.2 Types (exact)

```ts
export interface SlashSessionPort {
  send(sessionId: string | undefined, text: string): Promise<unknown>;
  clear(sessionId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface SlashContext {
  args: string;
  sessionId?: string;
  ids: IdGen;
  files: FilesPort["files"];
  interaction: Interaction;
  session: SlashSessionPort;
  say(text: string): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  argHint: string;
  description: string;
  run(ctx: SlashContext): Promise<void>;
}

export type SlashCommandInfo = Pick<SlashCommand, "name" | "aliases" | "argHint" | "description">;

export interface SlashRegistry {
  find(name: string): SlashCommand | undefined;
  list(): SlashCommandInfo[];
}

export function createRegistry(commands: SlashCommand[]): SlashRegistry;
export function runSlash(registry: SlashRegistry, deps: Omit<SlashContext, "args" | "sessionId" | "say"> & { emit(ev: RunEvent): void }, input: string, sessionId?: string): Promise<boolean>;
```

Decisions:
- `run(ctx)` takes one object: keeps `check:functions` (≤4 params) and lets new fields land without touching every command.
- `SlashSessionPort` is required, not optional. Growing it is the one deliberate seam: a new session capability = one port method + one wiring line in core. Commands never get `SessionService` itself.
- `say` replaces the module-private `local()`; it emits `chat.local` with `ids.next("slash")`.
- `createRegistry` throws on a duplicate name or alias (case-insensitive, names normalised to lower case). This is a programming error caught by tests, not a runtime condition.
- `/help` reads `registry.list()` through a closure: `builtinCommands()` builds the list, then `help` is created with a `() => SlashCommandInfo[]` getter, so help has no self-reference to a module-level array.
- `runSlash` wraps `cmd.run` in one `try/catch`: on throw it calls `say("/<name> failed: <message>")` and returns `true`. Commands drop their own outer catch where the message would be the same (`/clear`'s `.catch`); `/init` keeps its follow-up-specific messages.
- No `allowWhileBusy` flag: the composer is disabled while `busyRunId` is set (`Composer.tsx`), and session-level guards (e.g. `clear`'s active-run refusal) stay in `SessionService`. Revisit only if a command must run mid-turn.

### 2.3 Core wiring

`packages/core/src/handlers/chat.ts`:
- Build the registry once per `Core` (`createRegistry(builtinCommands())`), stored on `CoreCtx` or a module-level const in core — not per call.
- `handleChatSend` passes `session: { send: (id, text) => ctx.sessions.send({ sessionId: id, text }), clear: (id) => ctx.sessions.clear(id) }`.
- Import `runSlash`, `slashPlainText` from `@stewart/slash`.

### 2.4 Discovery: `slash.list`

- Protocol: add `"slash.list": { params: { projectId: string }; result: { commands: SlashCommandInfo[] } }` to the method map and `METHODS`; define `SlashCommandInfo` in protocol (slash imports it from protocol, so the wire type has one owner).
- Core: `"slash.list": (p) => ({ commands: registry.list() })`.
- Hosts (both must reply; JetBrains' default branch sends no reply):
  - VS Code `hosts/vscode/src/routes.ts`: `"slash.list": (ctx) => dispatchAndReply(ctx, "slash.list", { projectId: PROJECT_ID }, { type: "slash.commands" })`.
  - JetBrains `WebviewRouter.kt`: explicit `"slash.list"` branch sending `type: "slash.commands"`, mirroring `history.list`.
- Webview `bridge.ts`: outbound `{ type: "slash.list" }`, inbound `{ type: "slash.commands"; commands: SlashCommandInfo[] }`; store field `slashCommands: SlashCommandInfo[]`, requested once on `ready` (same place as `permissions.bypass`).

### 2.5 Composer autocomplete

New `packages/webview/src/SlashMenu.tsx` + pure `slashMenuModel.ts` (filter/selection logic, unit-tested without DOM):
- Opens when the draft matches `^/[a-z0-9-]*$` (single leading slash, no whitespace yet); closes otherwise, on Escape, or on blur.
- Filters `slashCommands` by prefix on name or alias; shows `/name argHint — description`.
- While open: Up/Down move the selection (taking precedence over prompt recall), Tab/Enter complete the draft to `/name ` (trailing space; Enter does not send while the menu is open), Escape closes.
- While closed: existing keys unchanged (Up/Down recall, Enter sends).

### 2.6 Optional phase: project prompt commands

Only after 2.1–2.5 land and only if wanted. Markdown files `.stewart/commands/<name>.md` become commands that send their body (with `$ARGUMENTS` replaced by `args`) through `session.send`. Constraints: trusted workspaces only (same gate as `.stewart/roles.yaml` in `modules/config/src/loader.ts`); a built-in name wins over a file name and the conflict is logged; loaded on config reload. Needs its own short design note before building.

## 3. Build order

Each step is one commit, green on its own (tests + `check:*`), with `ARCHITECTURE_NOW.md` updated in the same commit.

| Step | Change | Behaviour change |
|---|---|---|
| S1 | Create `@stewart/slash`; move `parse.ts`, commands, `runSlash` verbatim into the new layout with the 2.2 types; core imports from `@stewart/slash`; session drops `slash.ts` + re-exports; move `slash.test.ts` cases into per-file tests | None (same output text) |
| S2 | `createRegistry` with duplicate/alias check; `runSlash` central error capture; drop redundant per-command catches | Errors thrown by a command now show as `/<name> failed: …` instead of rejecting `chat.send` |
| S3 | `slash.list` protocol + core + both hosts + webview store field | New method only |
| S4 | Composer `SlashMenu` | New UI |
| S5 (optional) | Project prompt commands (2.6) | New commands from files |

## 4. Tests (positive + negative per step)

- S1: existing `/help`, `/init`, `/clear`, `parseSlash`, `slashPlainText`, unknown-command cases pass unchanged in the new files; core `chat.send` with `/help` still returns `{ sessionId }` and emits `chat.local`; session package no longer exports `runSlash` (typecheck).
- S2: duplicate name throws; alias colliding with another name throws; lookup by alias works; names are case-insensitive; a command whose `run` throws → `runSlash` resolves `true` and emits one `chat.local` with `/<name> failed: <msg>`; a non-throwing command emits no failure text.
- S3: protocol test covers `slash.list` in `METHODS`; core returns every built-in with `name`/`argHint`/`description`; VS Code `routes.test.ts` replies `slash.commands`; `WebviewRouterTest.kt` replies `slash.commands`; webview stores the list on `slash.commands` and requests it on `ready`.
- S4: `slashMenuModel.ts`: opens on `/`, `/cl`; stays closed on `//x`, `/clear now`, `hello /x`; prefix filter by name and alias; Up/Down wrap; completion yields `/name `. Component test: Enter with menu open completes and does not post `chat.send`; Enter with menu closed sends; Up with menu closed still recalls the previous prompt.

## 5. Verification

Per step, narrowest first: `./node_modules/.bin/vitest run` and `./node_modules/.bin/tsc -p tsconfig.json --composite false --noEmit` in each touched package (never plain `tsc -p` in `packages/webview`: it emits `.js` beside the sources). Then from root: `pnpm check:layers` (new module + dep counts; `--update` only for the new `slash` entry), `pnpm check:cycles`, `pnpm check:tsrefs` (fix with `node scripts/sync-tsrefs.mjs`), `pnpm check:boundaries`, `pnpm check:functions`, `pnpm check:docs`. S3 also: `./gradlew test` for `WebviewRouterTest`. Final gate after S4: `pnpm -r test`, `pnpm test:coverage`.

## 6. Docs to update

- `docs/ai_docs/ARCHITECTURE_NOW.md`: module table (new `slash` row, session row loses slash), §3a slash paragraph (registry, port, `slash.list`), Protocol row (`slash.list`), Webview row (slash menu).
- `docs/ai_docs/PROGRESS.md`: one note per step.
- `modules/slash/README.md`, `modules/session/README.md`.
- `AGENTS.md`: mark this plan implemented when S4 lands.

## 7. Risks

- `check:layers` dep-count ratchet: `core` gains `@stewart/slash`; accept with `pnpm check:layers --update` and say so in the commit.
- Composer key handling conflicts with prompt recall: covered by the S4 negative tests.
- JetBrains silently dropping `slash.list` if the explicit branch is missed: covered by `WebviewRouterTest`.

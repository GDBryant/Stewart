# Mid-run user guidance plan

**Status:** proposed
**Date:** 2026-11-25
**Goal:** while a run is active, `Enter` injects the user's message into the active running context (steer); `Ctrl+Enter` queues the message to run after the current round/task finishes.

## Current state (verified)

- **UI**: `packages/webview/src/Composer.tsx:107` — Enter sends; while busy the textarea is
  `disabled` (:149–150) and the button becomes Stop (:130). Nothing mid-run reaches the model.
- **Path**: webview `chat.send` → host bridge (`packages/webview/src/bridge.ts:4`) → VS Code
  dispatcher (`hosts/vscode/src/messageDispatcher.ts`) → core `chat.send` →
  `SessionService.send` (`modules/session/src/session.ts:73`).
- **Serialization**: `SessionService.enqueue` (:113) serializes turns per session on a promise
  chain — a `chat.send` arriving mid-run *already* becomes a queued follow-up turn; only the UI
  blocks it.
- **Injection seam**: `nativeLoop` calls `turn.beforeModelTurn` before every model request
  (`modules/engines/src/nativeLoop.ts:305`), wired per attempt in `session.task` (:198, currently
  just compaction). The active run's transcript (`TurnWork.transcript`) is the object the engine
  mutates, and `SessionService.active` (:67) maps runId → RunState.
- **Limitation**: the claude-code engine has `ownContext: true`
  (`modules/engines/src/claudeCode.ts:260`) — it manages its own context, so transcript injection
  won't reach it. Only native-loop engines support steer.

## Design

### Ctrl+Enter = queue (no protocol change)

- Webview stops disabling the composer while busy. Ctrl+Enter while busy posts `chat.send` as
  usual; the session chain runs it after the current run/task finishes. Idle: Ctrl+Enter ≡ Enter.
- Webview keeps a local queue list (text, id) and renders a small "queued" strip under the
  composer with per-item remove. Remove = discard locally; on `run.finished`/`chat.cleared` clear
  the strip. The queued turn is persisted by normal history once it runs.

### Enter = steer (new)

- **Webview**: busy + Enter → `chat.steer { runId: busyRunId, text }` (images: rejected in v1,
  plain text only).
- **Protocol** (`packages/protocol/src/index.ts`): add `CoreRequests["chat.steer"]` and an entry in
  `METHODS`.
- **Hosts**: add `chat.steer` to VS Code `CONTROL_MESSAGES` (runs immediately, like `chat.cancel`,
  `hosts/vscode/src/messageDispatcher.ts:4`) and to the JetBrains `WebviewRouter` route table.
- **Core** (`packages/core/src/core.ts`, `handlers/chat.ts`): `handleChatSteer` →
  `session.steer(runId, text)`.
- **Session** (`modules/session/src/session.ts`):
  - Add `TurnWork.steering: ChatMessage[]`; track the current `TurnWork` per active run so
    `steer()` can reach it (drop the reference in `runTurn`'s `finally`).
  - `steer(runId, text)`: find the run + engine; if engine `caps.ownContext` is true → reject with
    a reason (webview shows it and falls back to a queued send); else push
    `{ role: "user", content: text }` onto `w.steering` and stepSave.
  - Drain in the existing `beforeModelTurn` hook (`session.task` :198): move `w.steering` into
    `w.transcript` before the next model request. Consequences: FIFO; effective at the next model
    turn of the *lead* task (not delegated children); naturally after any pending tool batch;
    while paused on an approval/ask_user it simply waits.
  - Leftover semantics: if the run ends with undrained steers, re-queue them as
    `chat.send`-equivalent turns on the session chain (degrades to queued turns). Cancel clears
    undrained steers.
- **Policy**: steered text rides the channel's user-content policy (the existing
  `where: "user"` `policy.notice` path) — no new gate.

## Edge cases

- Multiple steers: FIFO, each its own user message.
- Steer during approval/question pending: stored, drained at the next model turn.
- OwnContext engine (claude-code): rejected with a clear reason; UI auto-falls back to queue.
- Budget/compaction: steered messages count in the window; compaction still runs in the same hook.
- Turn-limit `askAndRetry` / plan driver (`modules/session/src/planDrive.ts:69` pushes milestone
  text): steers interleave as user messages — accepted, transcript stays valid.
- Persistence: drained steers persist via stepSave; undrained steers and the webview queue strip
  are in-memory (lost on host restart) — document this.

## Tests

- `modules/session/test/steer.test.ts`: steer lands before the next model turn (fake engine /
  channel); FIFO; steer while ask_user is pending drains after the answer; leftover steer → queued
  turn; cancel discards; ownContext rejection.
- Webview: Composer keys — busy + Enter → `chat.steer`, busy + Ctrl+Enter → `chat.send`, idle +
  Ctrl+Enter → send; queue strip add/remove/clear on `run.finished`.
- Protocol schema test for `chat.steer`; VS Code dispatcher control-set test; JetBrains router
  test.

## Docs

`docs/ai_docs/ARCHITECTURE_NOW.md` (run path: steer hook, queue via session chain) +
`docs/ai_docs/PROGRESS.md`, in the same commit as the code (hard rule).

## Execution order

1. Protocol + core + session steer, with session tests.
2. Webview keys + queue UI, with webview tests.
3. Host routing (VS Code dispatcher, JetBrains `WebviewRouter`).
4. Docs.

~5–7 files per milestone. Milestone 1 carries the main risk: reaching the active `TurnWork` and
the drain timing relative to approvals, compaction, and budget notes.

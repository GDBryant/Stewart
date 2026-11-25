# Mid-run user guidance plan

**Status:** proposed (rev 2 — audited against code, 2026-11-25)
**Date:** 2026-11-25
**Goal:** while a run is active, `Enter` injects the user's message into the active running context (steer); `Ctrl+Enter` queues the message to run after the current round/task finishes.

## Current state (verified)

- **UI**: `packages/webview/src/Composer.tsx:107` — Enter sends; while busy the textarea is
  `disabled` (:149–150) and the button becomes Stop (:130). Nothing mid-run reaches the model.
  Ctrl+Enter is not handled anywhere. `state.ts:75` (`send`'s `busyRunId` guard) is the only
  send gate — core and session happily accept a mid-run `chat.send` and queue it.
- **Path**: webview `chat.send` → host bridge (`packages/webview/src/bridge.ts:4`) → VS Code
  dispatcher (`hosts/vscode/src/messageDispatcher.ts`) → core `chat.send` →
  `SessionService.send` (`modules/session/src/session.ts:73`).
- **Serialization**: `SessionService.enqueue` (session.ts:113) serializes turns per session on a
  promise chain — a `chat.send` arriving mid-run *already* becomes a queued follow-up turn; only
  the UI blocks it.
- **Injection seam**: `nativeLoop` calls `turn.beforeModelTurn` before every model request
  (`modules/engines/src/nativeLoop.ts:305`), wired per attempt in `session.task` (:198, currently
  just compaction). The active run's transcript (`TurnWork.transcript`) is the object the engine
  mutates, and `SessionService.active` (:67) maps runId → RunState.
- **Lead-only**: child task specs do not wire `beforeModelTurn` (`child.ts`), so steering reaches
  only the lead, not delegated children.
- **Limitation**: the claude-code engine has `ownContext: true`
  (`modules/engines/src/claudeCode.ts:260`) — it manages its own context, so transcript injection
  won't reach it. Only native-loop engines support steer.
- **Reply plumbing**: the VS Code fallback route (`routes.ts:104`) dispatches unknown types with
  **no reply** (errors become generic `error`). A new method that must return a result needs an
  explicit route entry in both hosts.

## Design

### Ctrl+Enter = queue (no protocol change)

- Webview stops disabling the composer while busy. Split `state.send`'s `busyRunId` guard: allow
  `send` while busy (it queues); add a separate `steer()` path. Composer: Ctrl+Enter while busy
  posts `chat.send`; idle: Ctrl+Enter ≡ Enter.
- Webview keeps a local queue list (text, id) and renders a small "queued" strip under the
  composer with per-item remove. Remove = discard locally.
- **Strip lifecycle: pop exactly one item per `run.finished`.** Each queued send becomes its own
  run (N items ⇒ N `run.started`/`run.finished` pairs); the session chain is strictly FIFO, so a
  positional pop matches. The webview cannot match by runId (the fallback route sends no reply
  for `chat.send`) — acceptable for v1. `chat.cleared` clears the strip entirely.
- The queued turn is persisted by normal history once it runs.

### Enter = steer (new)

- **Webview**: busy + Enter → `chat.steer { runId: busyRunId, text }` (images: rejected in v1,
  plain text only). On `chat.steer.result`: `ok` → append the user item; `ok:false` → auto-fall
  back to a queued send (strip entry + `chat.send`). A steer targeting an already-finished or
  cancelled run (Enter racing `run.finished`) gets `ok:false` and degrades the same way.
- **Protocol** (`packages/protocol/src/index.ts`): add
  `CoreRequests["chat.steer"] = { params: { projectId, runId, text }; result: { ok: boolean; reason?: string } }`
  and a `METHODS` entry. (METHODS is type-only; core dispatch checks the handler map, so the
  protocol test is the real guard.)
- **Hosts**:
  - VS Code: add `chat.steer` to `CONTROL_MESSAGES` (runs immediately, like `chat.cancel`,
    `messageDispatcher.ts:4`) **and** an explicit `ROUTES` entry that replies
    `chat.steer.result` (the fallback route posts no reply).
  - JetBrains: add `chat.steer` to the control branch (`WebviewRouter.kt:43`) with a shaped
    `chat.steer.result` reply — otherwise it serializes behind `routeLock` and gets no reply.
- **Core** (`packages/core/src/core.ts`, `handlers/chat.ts`): `handleChatSteer` →
  `session.steer(runId, text)`, returning the typed result.
- **Session** (`modules/session/src/session.ts`):
  - Add `TurnWork.steering: ChatMessage[]`; track the current `TurnWork` per active run (runId
    map, dropped in `runTurn`'s `finally`) so `steer()` can reach it.
  - **Engine-cap stamp**: the ownContext check needs the *current* attempt's engine, and
    escalation can switch engines mid-run (e.g. native → claude-cli). Stamp the attempt's engine
    caps on the `TurnWork` in `task()` at chain resolution (:177) and refresh on each
    `beforeModelTurn(agent)`; `steer()` reads the latest stamp. No stamp yet (steer before the
    first attempt) → resolve from the lead chain's channel.
  - `steer(runId, text)`: find the run in `active` (mirror `cancel()`, :82). Unknown runId →
    `{ ok:false, reason: "run not active" }`; `rs.controller.signal.aborted` → `{ ok:false,
    reason: "run cancelled" }`; stamped caps `ownContext` → `{ ok:false, reason }`; else push
    `{ role: "user", content: text }` onto `w.steering` and stepSave.
  - Drain in the existing `beforeModelTurn` hook (`session.task` :198): move `w.steering` into
    `w.transcript`, then call `w.stepSave()` explicitly so a crash between drain and turn end
    doesn't lose it. Consequences: FIFO; effective at the next model turn of the *lead* task
    (not delegated children); naturally after any pending tool batch; while paused on an
    approval/ask_user it simply waits.
  - Leftover semantics: when a run ends (any status) with undrained steers, re-queue each as a
    `send()` on the session chain (degrades to queued turns). Documented limits: they line up
    *after* already-queued items and start runs the strip no longer represents (the strip is
    popped per run) — acceptable v1. Re-queue fires on failed runs too — intended, the guidance
    is still valid. Cancel (aborted) discards undrained steers.
- **Policy**: steered text rides the channel's user-content policy (the existing
  `where: "user"` `policy.notice` path) — no new gate.

## Edge cases

- Multiple steers: FIFO, each its own user message.
- Steer during approval/question pending: stored, drained at the next model turn.
- OwnContext engine (claude-code): typed rejection with a reason; UI auto-falls back to queue.
- Engine switch mid-run: the drain happens only in the native-loop's `beforeModelTurn`, so the cap
  stamp is what `steer()` checks — reject when the *current* attempt is ownContext (steering would
  never drain while that engine runs). A steer already drained into the shared transcript is not
  lost on escalation: the claude-code engine writes unseen transcript deltas (incl. drained
  steers) to the CLI on each attempt (`claudeCode.ts:194` + `unseenPrefix`). A steer accepted
  during a native attempt but escalated to ownContext before its drain stays in `w.steering` and
  re-queues at run end (degradation, documented).
- Steer on a finished/cancelled run: `ok:false`, webview queues it.
- Budget/compaction: steered messages count in the window; compaction still runs in the same
  hook. The turn-limit nudge is pushed *after* the hook (`nativeLoop.ts:306`), so steered text
  precedes the nudge.
- Turn-limit `askAndRetry` / plan driver (`planDrive.ts:69` pushes milestone text): steers
  interleave as user messages — accepted, transcript stays valid.
- Persistence: drained steers persist via the drain stepSave + final persist; undrained steers
  and the webview queue strip are in-memory (lost on host restart) — document this.

## Tests

- `modules/session/test/steer.test.ts`: steer lands before the next model turn (fake engine /
  channel); FIFO; steer while ask_user is pending drains after the answer; leftover steer →
  queued turn (both `done` and `failed` runs); cancel discards; ownContext rejection; steer
  against an unknown runId; steer after abort; engine switch mid-run (first attempt native,
  escalation to ownContext → later steers rejected).
- Webview: Composer keys — busy + Enter → `chat.steer`, busy + Ctrl+Enter → `chat.send`, idle +
  Ctrl+Enter → send; queue strip with **multiple** items pops one per `run.finished` and clears
  on `chat.cleared`; steer `ok:false` falls back to a strip entry + `chat.send`.
- Protocol schema test for `chat.steer` (in `METHODS` + shape); VS Code dispatcher control-set
  test and `chat.steer.result` reply-shape test; JetBrains router test (control branch + reply).

## Docs

`docs/ai_docs/ARCHITECTURE_NOW.md` (run path: steer hook, queue via session chain) +
`docs/ai_docs/PROGRESS.md`, in the same commit as the code (hard rule).

## Execution order

1. Protocol + core + session steer (incl. engine-cap stamp and stale-run handling), with session
   tests.
2. Webview keys + queue strip (per-run pop) + steer fallback, with webview tests.
3. Host routing: VS Code `CONTROL_MESSAGES` + `ROUTES` entry; JetBrains control branch + reply.
4. Docs.

~5–7 files per milestone. Milestone 1 carries the main risk: reaching the active `TurnWork`,
the engine-cap stamp, and the drain timing relative to approvals, compaction, and budget notes.

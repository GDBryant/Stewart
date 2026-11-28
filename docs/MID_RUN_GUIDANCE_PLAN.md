# Mid-run user guidance plan

**Status:** proposed (rev 4 — UX interrogation, 2026-11-28)
**Date:** 2026-11-25 (rev 4: 2026-11-28)
**Goal:** while a run is active, `Enter` injects the user's message into the active running context (steer); `Ctrl+Enter` (`Cmd+Enter` on macOS) queues the message to run after the current run finishes.

**UX success criteria:** the user can tell where the text will go before sending it, can use either keyboard or mouse, never loses text silently, can honestly remove a queued follow-up before it is sent, and gets the same meaning in both hosts.

## UX interrogation findings (rev 4)

1. **Rev 3's queue removal was dishonest.** Ctrl+Enter posted `chat.send` immediately, so the turn was already in the session chain; removing the strip item only hid it. The follow-up would still run. The queue must either be client-held until dispatch or server-cancellable. Rev 4 chooses a client-held outbox for v1.
2. **Positional popping was unsound.** Extra runs (plan resume, a server-requeued steer, another panel) would pop the wrong visible item. A client-held outbox removes an item only after an accepted dispatch, not on every `run.finished`.
3. **The design was keyboard-only and undiscoverable.** A busy composer needs a visible hint and clickable Guide/Queue actions; Stop cannot remain the only button.
4. **`ok` only means buffered, not seen by the model.** The user bubble must say "guidance" without claiming application; any explanatory copy must say the earliest possible read is the next model step. Failure fallback must be explicit, not silent.
5. **Engine-dependent fallback is a product inconsistency.** Claude Code's stream-json input is realtime, and the Agent SDK documents messages sent during tool calls as reaching Claude after those calls; `SDKUserMessage.priority` includes `now`/`next`/`later`. The current engine does not use that seam, but ownContext is not proven as a hard product limitation. Spike direct CLI steering before accepting permanent fallback.
6. **Images are high-value steering evidence.** "This screenshot/error" is exactly what users send mid-run. Text-only steering is an artificial UX limitation; `chat.steer` should carry images like `chat.send`.
7. **Slash fallback changed meaning.** Text intended as literal guidance could become a slash command when fallback/re-queue used `chat.send`. Steer input must be normalized once and requeued as a literal session turn.
8. **Cancel could discard unseen guidance.** At minimum the transcript keeps the accepted guidance bubble; do not claim it was applied. Longer term, report undrained steers so the UI can restore or requeue them deliberately.
9. **Session switching makes the control target ambiguous.** `history.load` currently clears `busyRunId` while the run continues. v1 must block switching away from the controlled session while a run/outbox is active.
10. **Steering reaches the lead only.** A running delegated child does not receive it. The UI copy and docs must not imply instant interruption of all work.

## Current state (verified)

- **UI**: `packages/webview/src/Composer.tsx:107` — Enter sends; while busy the textarea is
  `disabled` (:149–150) and the button becomes Stop (:130). Nothing mid-run reaches the model.
  Ctrl+Enter is not handled anywhere. `state.ts:75` (`send`'s `busyRunId` guard) is the only
  send gate — core and session happily accept a mid-run `chat.send` and queue it.
- **Path**: webview `chat.send` → host bridge (`packages/webview/src/bridge.ts:4`) → VS Code
  dispatcher (`hosts/vscode/src/messageDispatcher.ts`) → core `chat.send` →
  `SessionService.send` (`modules/session/src/session.ts:77`).
- **Serialization**: `SessionService.enqueue` (session.ts:117, per-session promise chain on
  `chains` :72) serializes turns per session — a `chat.send` arriving mid-run *already* becomes a
  queued follow-up turn; only the UI blocks it.
- **Injection seam**: the native loop calls `turn.beforeModelTurn?.({ measured })` before every
  model request (`nativeLoop.ts:32`), wired once in `session.task` (:204, currently just
  compaction); the budget nudge (`budgetTurn`, `nativeBudget.ts`) is pushed *after* the hook
  (`nativeLoop.ts:33`), so drained steers precede it. The active run's transcript
  (`TurnWork.transcript`) is the object the engine mutates; `SessionService.active` (:68) maps
  runId → `RunState` (`turnState.ts:23-31`, created per run by `newRunState()` :57) — `RunState`
  is the natural home for per-run steer state (no second runId map needed; `runTurn`'s `finally`
  :165-166 already drops it).
- **Lead-only**: child task specs do not wire `beforeModelTurn` (`child.ts`), so steering reaches
  only the lead, not delegated children.
- **Claude limitation, with a likely escape hatch**: the claude-code engine has `ownContext: true`
  (`claudeCode.ts:259-260`) and currently writes exactly one user line at attempt start
  (`claudeCode.ts:194`, `claudeLines.ts:42-49`). Its CLI subprocess owns the model loop, so there
  is no per-turn drain point in Stewart today. However `claude --help` (2.1.332) describes
  stream-json as "realtime streaming input", and the Agent SDK's streaming-input documentation
  says a message sent during tool calls reaches Claude after those calls
  (https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). Direct CLI steering is
  therefore a spike, not a rejected fact. (Drained steers already reach a *later* claude-code
  attempt: `unseenPrefix` rebuilds the CLI view from the transcript per attempt,
  `claudeCode.ts:240`, `claudeLines.ts:102/114`.)
- **Policy**: outbound content policy already covers injected user messages — `applyOutbound`
  runs on every channel request (`channels/registry.ts:66`) and the claude path screens in
  `claudePolicy.ts`; no new gate.
- **Reply plumbing**: the VS Code fallback route (`routes.ts`, after the `ROUTES` map) dispatches
  unknown types with **no reply** (errors become generic `error`). A method whose result the UI
  needs requires an explicit route entry in both hosts. `CoreRequests["chat.send"]` already has a
  typed `{runId?, sessionId?}` result (`packages/protocol/src/index.ts:150`); the hosts simply do
  not forward it today.

## Interaction design

### Composer affordance

- The textarea stays enabled while a run is active. Placeholder: `Guide this run…` while busy,
  `Ask Stewart` when idle.
- Busy hint row, always visible while busy: `Enter guides · Ctrl+Enter queues · Shift+Enter newline`.
  On macOS render `⌘Enter` instead of `Ctrl+Enter`. The textarea points at it with
  `aria-describedby`; the hint is not tooltip-only.
- Buttons: idle = `Send`; busy = `Guide` (primary), `Queue`, `Stop`. Attach stays available.
  Buttons are real `<button>`s, keyboard-focusable, with tooltips and `aria-keyshortcuts`
  (`Enter` on Guide, `Control+Enter`/`Meta+Enter` on Queue). Keep Stop visually separated/rightmost.
- Keyboard: plain `Enter` steers while busy; `Ctrl+Enter` or `Cmd+Enter` queues while busy;
  either one is a normal send while idle; `Shift+Enter` always inserts a newline. The slash menu
  consumes only plain Enter for completion — modified Enter must fall through to queue.
- Composer mode is explicit state, not guesswork: `steer` when a started run exists, `queue` when
  `outboxSending` or unsent items exist but no started run exists, otherwise `idle`. In queue mode
  both Enter keys append to the outbox so a later message cannot slip ahead of the outbox head.
- Slash-command intent wins over steer: when the first token matches a known slash command or alias,
  busy Enter queues the command rather than injecting it as guidance. Text with a leading slash that
  is not a known command (`/tmp/log`, `//help`) remains literal guidance.
- Copy uses user-facing **Guide/guidance**; `steer` stays protocol/internal vocabulary.

### Steering lifecycle

- Submission is optimistic but recoverable: capture text + pending images, clear the composer,
  disable only the Guide action while `chat.steer` is in flight, and keep a short timeout (3 s).
- `ok:true` → close the current assistant segment and append a user bubble flagged as guidance.
  Role label: `user · guidance`; small caption: `sent while the run was active`.
  This is an acknowledgement of buffering, not proof the model has read it; because there is no
  drain event in v1, the persistent bubble must not claim application.
- `ok:false` → enqueue the same content in the local outbox and show an inline warning in the
  composer area: `Couldn't guide this run — <reason>. Queued as a follow-up.` Map reasons to
  user copy (`engine unsupported` → `this agent can't take guidance mid-run`, `run not active` →
  `the run already finished`, `steer limit` → `too much pending guidance`).
- Timeout/transport error → prepend the submitted text before any newer draft and restore images
  (subject to the existing caps), then show `No confirmation from Stewart; your text was restored.`
  Do not auto-retry (the steer may have landed).
- A steer is literal user guidance, not a slash command. `handleChatSteer` applies mention
  expansion and image normalization exactly as typed (no slash unescape), then preserves the
  resulting literal text if it is later requeued.

### Queue/outbox lifecycle

- The queue is a **client-held outbox**: Ctrl/Cmd+Enter while busy only records
  `{id, sessionId, text, images?, createdAt}` in webview memory. It does **not** post `chat.send`
  until the item reaches the head and no run/outbox dispatch is active. Therefore Edit/Remove are
  honest: the item has not been sent anywhere.
- Render the strip inside `.composer-wrap` **above** the composer, `aria-label="Queued follow-ups"`,
  `aria-live="polite"`; one line per item with a `Next` badge on the head, image count when present,
  and the text ellipsized. Maximum height with scrolling rather than pushing the composer off screen.
- Each row has `Edit` and `×`: Edit is enabled only when the draft is empty and moves the content
  back into the composer; `×` discards the unsent item. Tooltips state the exact behavior.
- Cap the visible outbox at 20 items; at the cap disable Queue and show the existing hint area text
  `Too many queued follow-ups.`
- `pumpQueue()` runs after enqueue, `run.finished`, a `chat.send.result`, and user retry. It marks
  only the head `sending`, leaves it in the strip, and posts `chat.send` with the captured session id;
  Edit/× are disabled while in flight and no user bubble is appended yet. `ok:true` removes the head,
  appends the normal user bubble, and records `runId` when present. A `runId` keeps `outboxSending`
  as a bridge until the matching `run.started`; no `runId` (local slash output) releases it and pumps
  the next item. `ok:false` marks the head failed, keeps it editable/removable, shows Retry, and pauses
  the outbox — never silently cascade-send dependent follow-ups. A 3 s timeout pauses with
  `No confirmation; retry can duplicate if the send still lands.` While `outboxSending` or queued items
  exist, no later queued message can jump ahead in the queue lane; plain Enter may still steer a started run.
- Wire explicit `chat.send` replies in both hosts (`chat.send.result { ok:true, runId?, sessionId? }`,
  `{ ok:false,error }` on throw). The outbox uses the reply to distinguish a real run from local slash
  output and to release `outboxSending` without guessing. Idle sends may ignore the reply.
- `chat.cleared` clears all unsent outbox items and `outboxSending`. Already dispatched items are
  ordinary sends and cannot be recalled from the strip.
- Reload boundary: unsent outbox items are panel-memory only and are lost on reload. This is safer
  than rev 3's hidden server queue, but the strip tooltip/title must say `unsent; kept only in this panel`.

### Session/history guard

- While `busyRunId`, `outboxSending`, or unsent outbox items exist, disable New chat, opening a
  history session, and deleting the active session; tooltip: `available when the current run finishes`.
  The History list itself and Chat↔Settings switching remain available.
- This is a v1 guard around the existing single-active-session webview model, not the desired final
  multi-session UX.

## Technical design

### Ctrl/Cmd+Enter = queue (client-held, no core queue API)

- Webview stops disabling the composer while busy. Split `state.send`'s `busyRunId` guard into
  `sendNow` (normal/idle or dispatched outbox head), `enqueueFollowup` (client-held), and `steer`.
- No core/session queue change for follow-ups in v1: because they are not posted early, the existing
  per-session chain only ever sees them once they become the next user turn.
- A queued slash command executes only when dispatched. A failed steer that falls back into the
  outbox preserves a leading slash literally by prefixing one more slash (`/x` → `//x`,
  `//x` → `///x`) so it cannot become a command later.
- The queued turn is persisted by normal history once it runs.

### Enter = steer (new)

- **Webview**: busy + Enter → `chat.steer { runId: busyRunId, text, images? }`. Images are allowed;
  the same count/size validation as send applies client-side and core-side.
- **Protocol** (`packages/protocol/src/index.ts`): add
  `CoreRequests["chat.steer"] = { params: { projectId, runId, text, images? }; result: { ok: boolean; reason?: string } }`
  and a `METHODS` entry. Export one `STEWART_GUIDANCE_MARKER` constant here so session persistence
  and webview history rendering cannot drift.
- **Hosts**:
  - VS Code: add `chat.steer` to `CONTROL_MESSAGES` (runs immediately, like `chat.cancel`,
    `messageDispatcher.ts:4`) **and** an explicit `ROUTES` entry that replies
    `chat.steer.result` (the fallback route posts no reply). Add the explicit `chat.send` reply
    route described above.
  - JetBrains: add `chat.steer` to the control branch (`WebviewRouter.kt:49`, today
    `chat.cancel`/`approve`/`answer`) with a shaped `chat.steer.result` reply (the
    `chat.resume`/`chat.revert` pattern at `:105-111`) — otherwise it serializes behind
    `routeLock` and gets no reply. Add the shaped `chat.send.result` branch too.
- **Core** (`packages/core/src/core.ts`, `handlers/chat.ts`): `handleChatSteer` applies
  `expandMentions` and `normalizeImages` to the literal text, then calls
  `session.steer(runId, text, images)` and returns the typed result.
- **Session** (`modules/session/src/session.ts`, `turnState.ts`):
  - Add `steers: { text: string; images?: string[] }[]` + `steerable?: boolean` to `RunState`
    (init in `newRunState()`). No new map: `steer()` looks the run up in `active` (already keyed
    by runId), and the drain closure in `task()` already holds `w` (hence `w.rs`) in scope.
  - **Engine-cap stamp**: the current-attempt check belongs in `taskRun.attempt()` after
    `engineFor(channel.cfg.type)` (`taskRun.ts:163`); stamp `spec.run.steerable` there and once in
    `task()` from the `eligibleChain` head (:183) for the pre-first-attempt window. If the Claude
    spike lands, stamp from a real `caps.liveInput`/equivalent capability rather than `!ownContext`.
  - `steer(runId, text, images?)`: unknown runId → `{ ok:false, reason: "run not active" }`;
    aborted → `run cancelled`; current engine cannot steer → `engine unsupported`; blank text with no
    images → `empty`; >20 pending → `steer limit`; else push onto `rs.steers`.
  - Drain in the existing `beforeModelTurn` hook (`session.task` :204): after compaction, move
    `w.rs.steers` into `w.transcript` as marked user messages, then call `w.stepSave()` explicitly —
    `taskRun` declares `onStep` (`taskRun.ts:53`) but never calls it, so the drain must persist
    itself. FIFO; effective at the next model turn of the *lead* task (not delegated children);
    naturally after any pending tool batch; while paused on an approval/ask_user it waits.
  - **Marker**: push each drained steer as `<STEWART_GUIDANCE_MARKER><text>` with images preserved.
    The marker tells the model this is mid-run guidance to fold into current work. On history load
    the webview strips this exact marker, sets the guidance flag, and renders clean user text rather
    than exposing the machine prefix.
  - Leftover semantics: when a run ends `done` or `failed` with undrained steers, requeue each by
    calling `SessionService.send` directly (not core `chat.send`), preserving literal text and
    images. Register those sends before emitting terminal `run.finished`, so they enter the session
    chain ahead of later client-outbox turns because they were submitted earlier. Cancel discards
    undrained steers; the already visible guidance bubble remains the user's copy. Document that
    direct-child steering and cancellation/recall of accepted steers are not v1.

### Claude live-input spike (before deciding fallback forever)

- Spike direct CLI steering on the installed line format before accepting permanent fallback copy:
  write a second stream-json user message while a fake/real long-running turn is active, shaped
  approximately as `{ type:"user", uuid, message:{ role:"user", content }, parent_tool_use_id:null,
  priority:"next", origin:{kind:"human"}, client_composed:true }`; launch with
  `--replay-user-messages` and confirm the replay/result association.
- Also probe: image blocks, behavior while a `can_use_tool` approval is pending, behavior when the
  turn ends before the write, and minimum supported CLI version/help text.
- If confirmed, add a narrow engine live-input seam rather than treating ownContext as unsupported:
  the session owns ordering/transcript/persistence, the claude engine registers a per-attempt writer
  while its process is active, and accepted steers are written with `priority:"next"` (never `now`
  in v1). If not confirmed, keep the typed `engine unsupported` fallback — with the visible fallback
  notice above.

## Edge cases

- Multiple steers: FIFO, each its own user message.
- Steer during approval/question pending: stored, drained at the next model turn. Composer guidance
  never answers the question card; the card keeps its own reply input.
- OwnContext/live-input failure: typed rejection with a reason; UI visibly falls back to the outbox.
- Engine switch mid-run: the drain happens only in the native-loop's `beforeModelTurn`, so the cap
  stamp (set per attempt in `taskRun.attempt()`) is what `steer()` checks. A steer already drained
  into the shared transcript is not lost on escalation: claude-code writes unseen transcript deltas
  (incl. drained steers) to the CLI on each attempt (`claudeCode.ts:240` + `unseenPrefix`,
  `claudeLines.ts:114`). A steer accepted during a native attempt but escalated before its drain
  stays in `rs.steers` and requeues at run end.
- Steer on a finished/cancelled run: `ok:false`, webview outboxes it; if nothing is active it pumps
  immediately as a normal follow-up.
- Budget/compaction: steered messages count in the window; compaction still runs in the same hook.
  The turn-limit nudge (`budgetTurn`, `nativeBudget.ts`) is pushed *after* the hook
  (`nativeLoop.ts:33`), so steered text precedes the nudge and the report-only last turn.
- Other mid-run user pushes — turn-limit `askAndRetry`, plan milestones (`drivePlan`,
  `planDrive.ts:71`), escalation handover text (`taskRun.ts:200`): steers interleave as marked user
  messages — accepted, transcript stays valid.
- Lead/delegation boundary: guidance reaches the lead at its next model step; it does not interrupt a
  running child task. The user can still Stop the run for urgent interruption.
- Persistence: drained steers persist via the drain stepSave + final persist; undrained accepted
  steers are in-memory run state; unsent outbox items are panel-memory only.
- Multiple webview panels are not coordinated in v1. Session switching is blocked locally, but a
  second panel can still interleave sends; a durable server-owned outbox is future work.

## Tests

- `modules/session/test/steer.test.ts`: steer lands before the next model turn with the marker
  (fake engine / channel); text+image steer; FIFO; drain persists via `stepSave`; steer while
  ask_user is pending drains after the answer; leftover steer → direct literal session turn (both
  `done` and `failed` runs, no slash reinterpretation); cancel discards; ownContext/live-input
  rejection (incl. pre-attempt stamp); >20 pending → `steer limit`; blank text with no images →
  `empty`; unknown runId; steer after abort; engine switch mid-run.
- Claude spike tests (fake spawn unless the real-CLI spike is manual): second user line shape includes
  `priority:"next"`/human origin/client-composed/uuid; image block; approval-pending behavior; turn-end
  write failure falls back without corrupting transcript ordering.
- Webview: Composer keys — busy + Enter → `chat.steer`, busy + Ctrl/Meta+Enter → outbox only (no
  immediate `chat.send`), idle + Ctrl/Meta+Enter → send, Shift+Enter newline; slash menu consumes
  plain Enter but not modified Enter; known slash commands queue rather than steer; unknown leading
  slashes stay literal; queue mode captures both Enter keys while `outboxSending`; busy
  placeholder/hint/buttons; images can steer.
- Webview outbox: enqueue does not post; FIFO pump on `run.finished`; no bubble until `ok:true`;
  no jump-ahead while `outboxSending`; `chat.send.result` without runId (slash output) releases the
  outbox; dispatch failure pauses with Retry/Edit/Remove; timeout pauses without auto-retry; cap;
  `chat.cleared` clears unsent entries; reload loss is not hidden (copy present); fallback steer is
  slash-escaped.
- Webview steer ack: ok appends a guidance-flagged bubble and closes the prior assistant segment;
  failure enqueues + visible warning; timeout restores text before newer draft; history load strips
  the marker and renders the guidance label.
- Protocol schema test for `chat.steer` (in `METHODS` + shape, images allowed); VS Code dispatcher
  control-set and reply-shape tests for `chat.steer`/`chat.send`; JetBrains router tests for both.
- Accessibility smoke tests: textarea `aria-describedby`, queue strip `aria-live`, buttons expose
  names/shortcuts, keyboard-only queue/edit/remove path.

## Docs

`docs/ai_docs/ARCHITECTURE_NOW.md` (run path: steer hook, client-held outbox, host replies) +
`docs/ai_docs/PROGRESS.md`, in the same commit as the code (hard rule).

## Execution order

0. Claude live-input spike. Timebox it; do not let it block the native-loop path.
1. Protocol + core + session steer (incl. images, mention expansion, engine-cap stamp and stale-run
   handling), with session tests.
2. Host routing: VS Code `CONTROL_MESSAGES` + `ROUTES` entries; JetBrains control branch + shaped
   replies (`chat.steer`, `chat.send`).
3. Webview composer affordance + steer ack lifecycle + client-held outbox, with webview tests.
4. Docs.

~5–7 files per milestone. Milestone 1 carries the main technical risk: the engine-cap stamp across
attempts/escalation (`taskRun.attempt()` + pre-attempt window), drain timing relative to approvals,
compaction, and budget notes, and (if the spike passes) the claude live-input seam. Milestone 3
carries the main UX risk: the outbox state machine must make send order visible without ever lying
about whether removal worked.

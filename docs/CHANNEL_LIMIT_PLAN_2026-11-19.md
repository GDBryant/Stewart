# Channel limit vs. delegated reviewers — plan (2026-11-19)

## Finding
The channel limit was **not ignored on the wire**. Debug log `…/PyCharm2026.3/log/stewart/debug_logs/2026-11-19.log`, window 17:48–18:30: no second in which two reviewer tasks streamed from Ollama at once. `ManagedChannel` (`modules/channels/src/registry.ts`) serialised the requests (`ollama-local`, `maxParallel: 1`).

What the user saw is real, though: `ChildRunner` (`modules/session/src/child.ts`, `MAX_CHILDREN = 4`) admits 4 delegates regardless of the target channel. Log shows `task.created/started` ×4 at the same instant (17:48:56, 18:14:05, 18:25:58). Three of the four sit blocked in `ManagedChannel.acquire()` while presented as running.

## Root causes
1. **Admission is channel-blind.** `ChildRunner.limited()` has one global cap; it never consults the role's channel `maxParallel`. Children "run" (budgets/timers tick, UI shows active) while queued on the channel.
2. **Limiter state is lost on reload (latent, unconfirmed in this incident).** `ChannelService.rebuild()` does `managed.clear()` and builds new `ManagedChannel`s with `running = 0`. In-flight calls keep the old instance, new calls get a fresh semaphore → effective concurrency can exceed `maxParallel` after any `core.reload` (setup, config watcher). The user changed channel config mid-session, so this is plausible; not proven in the log.
3. **Minor:** `ManagedChannel.acquire()` handoff is not atomic (`release()` decrements, waiter increments later; a new caller can slip in between). Fix by transferring the slot directly to the waiter.

## Fix
1. **Channel-aware child admission.** Before taking a child slot, resolve the role→agent→channel; gate on a per-channel limit (`maxParallel`) in addition to `MAX_CHILDREN`. Waiting children are `queued` (no new event: `task.created` is emitted before admission, shown `pending`; `task.started` only once admitted), and their time/turn budgets start only after admission.
2. **Persistent limiter.** Reuse an existing `ManagedChannel` in `rebuild()` when its config is unchanged (update cfg/secret in place when only `maxParallel`/secret changed); never zero `running`.
3. **Atomic slot handoff** in `ManagedChannel.acquire/release`.
4. Optional: log a one-line `[channel] <id> queue depth N` when a request waits.

## Tests (positive + negative)
- 4 parallel delegates, role on `maxParallel:1` channel → 1 admitted, 3 `queued`; all complete in order.
- Same with `maxParallel:4` → all 4 run together.
- Tasks on different channels don't block each other; `MAX_CHILDREN` still caps total.
- `rebuild()` mid-run with 1 in flight on `maxParallel:1` → second request still waits; changed `maxParallel` applies to new admissions.
- `acquire` handoff: release + simultaneous new acquire never exceeds limit.
- Queued child's turn/time budget not consumed while waiting.

## Housekeeping
- Update `docs/ai_docs/ARCHITECTURE_NOW.md` (child admission, channel limiter, `task.queued` in protocol) in the same commit.
- Add reference to this doc in `AGENTS.md`.
- Separate observation (not part of this fix): most reviewer tasks failed on model output (`health report: expected exactly one ```json block`, invalid tool-call JSON from `ornith-1.5:9b`) — a model-fit problem, worth its own look.

## Open check
Confirm which `channels.yaml` PyCharm used (`~/.config/JetBrains/PyCharm2026.3/stewart/<project-id>/`); I only read the IntelliJ copy (`ollama-local` `maxParallel: 1`).

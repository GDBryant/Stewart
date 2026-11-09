# Setup wizard model quick-probe plan

## Outcome
Replace the setup wizard's hanging all-at-once probe burst with one server-owned, ordered smoke-test queue for every model returned by configured channels. Probe Ollama and Claude CLI models first, then have the selected evaluator agent rank remaining candidates by expected usefulness; execute smoke tests in that order, mark green/orange/red, allow early acceptance, and feed green results into recommendation.

## Grounding and current behavior
- `packages/webview/src/SetupWizard.tsx` currently calls `store.probeModel()` for every discovered pair in a React effect. A new request can be sent whenever the effect reruns, so requests are not serialized or cancellable.
- `packages/core/src/handlers/setup.ts` `handleChannelProbe()` awaits `probeCaps()`, then optionally runs `benchModel()`. `benchModel()` already uses several bounded operations, but `probeCaps()` and the initial capability probe can wait on provider requests without a single hard overall deadline.
- `modules/channels/src/openai.ts` `probeCaps()` sends a non-streaming completion without an abort signal or request deadline. `modules/channels/src/ollama.ts` uses `/api/show` and can report native tools without an inference call. `modules/channels/src/claude/adapter.ts` returns static caps and needs a real bounded model smoke request.
- The current webview state has only final probe success/failure results; it does not represent queued/running/timeout states or an accept-and-continue control.
- `packages/protocol/src/index.ts`, both host routers, webview bridge/state, core handler, setup module, and tests must change together. JetBrains and VS Code need matching routes; protocol type and tests must reflect new messages.

## Decisions
- Treat the selected step-2 channel/agent as the evaluator used to rank candidates. All channel models are candidates, not only models already represented by agents.
- Use a fixed provider-first order: all enabled Ollama models, then all enabled Claude CLI models, then remaining models sorted by the evaluator's usefulness ranking. If the evaluator ranking request fails or times out, preserve deterministic name/provider order rather than blocking setup.
- Every candidate gets one lightweight smoke request, not the full benchmark suite. Use one tiny prompt, one model turn, low token cap where supported, and a hard 30-second deadline covering queue admission, provider request, response completion, and parsing. On timeout classify as orange; failed/unusable responses classify as red; successful response classifies as green.
- Run one smoke probe at a time per project to avoid flooding channels and make ordering/cancellation deterministic. Respect each channel's existing `maxParallel`/managed-channel behavior, but do not launch a broad parallel fan-out from the wizard.
- “Accept and continue” stops admitting new candidates and aborts any in-flight candidate. Preserve results already completed and mark unfinished candidates as skipped; recommendation continues with the available green results. Do not wait for the full queue.
- Green means the candidate passed the smoke test. It does not mean every capability was discovered; capability details remain best-effort/defaulted. Red is discarded from this setup run's candidate set for recommendation. Orange is not treated as a successful candidate; it remains visible as timed out and is excluded unless the user explicitly retries after setup.
- After smoke completion or early accept, use the same selected evaluator agent to rank only green candidates for recommendation order where feasible. Retain Ollama/Claude priority as a stable first tier and do not let a failed evaluator ranking block rules-based assignment. AI refinement remains the existing later step and must validate hard requirements.
- Keep full `benchModel()` opt-in and separate from the setup quick probe. It remains behind the existing “Measure speed” control and is not part of the 30-second quick pass.

## Implementation tasks

### 1. Define a bounded setup probe contract and runner
- Add a setup-owned smoke probe function/API with candidate identity (`channel`, `model`), provider/type, explicit 30-second timeout, cancellation signal, and result enum (`green`, `red`, `orange`, plus reason/error). Do not overload final `channel.probe.result` with ambiguous success semantics.
- Implement one-at-a-time scheduling per project. Queue candidates in the required order; skip duplicate channel/model pairs; support start, cancel/accept, status polling, and resume-safe state where practical.
- Ensure cancellation aborts the underlying chat request and releases the scheduler slot. A timeout must be distinguished from provider failure.
- Cache completed results for the wizard session so leaving/re-entering the step does not restart probing. Reuse existing capability cache only when its provenance is compatible; do not treat old capability-only cache entries as smoke-test results.
- Add protocol request/result types and host forwarding for start/status/cancel (or one start with streaming status if the existing event path supports it cleanly). Keep JetBrains and VS Code behavior equivalent.

### 2. Implement provider-aware smoke requests
- Use the selected channel's managed channel and the same adapter constraints as normal chat.
- Send one minimal deterministic prompt asking for a short exact response (for example, reply with `OK`), with no tools, no images, and the smallest practical token limit. Do not use `probeCaps()` as the liveness test because it is capability-oriented and may hang.
- For OpenAI-compatible channels, make the request streaming or otherwise ensure the overall timeout aborts both connection establishment and body consumption. Do not rely only on the stream stall timeout.
- For Ollama, use the normal chat path with a short `num_ctx` appropriate for the tiny prompt and the configured model cap; do not load unnecessary capabilities or run `/api/show` repeatedly if already known.
- For Claude CLI, use the normal adapter chat path with the 30-second abort and the CLI's existing isolated temp-directory lifecycle; do not infer success from static `probeCaps()`.
- Treat HTTP errors, malformed/empty responses, missing completion, tool-only output, and timeout distinctly enough for the UI reason. Classify timeout as orange; all other unusable outcomes as red.
- Preserve secrets and existing channel breaker behavior; a smoke timeout should not permanently mark a channel unhealthy unless the underlying adapter already classifies it that way.

### 3. Build candidate ordering and evaluator ranking
- Gather candidates from all enabled channels after channel model discovery, deduplicate channel/model pairs, and attach existing agent metadata when present.
- Put Ollama candidates first and Claude CLI candidates second. Within those provider groups, use deterministic stable ordering (prefer configured/existing agents, then model name/size heuristics already available in setup scoring where appropriate).
- For remaining candidates, ask the selected evaluator agent for a compact usefulness ranking using candidate metadata already available (channel type, model name, known caps/price/context). Bound this ranking call with its own timeout and token limit; do not send every model's full prompt history.
- Validate the evaluator response against the candidate set, discard unknown/duplicate entries, and append any omitted candidates deterministically. If ranking fails, use the deterministic fallback order. The ranking request must never delay the first Ollama/Claude smoke probe beyond a short bounded ranking timeout.
- After smoke results are known, rank green candidates again for recommendation display/order using the same evaluator when available. Keep provider priority and deterministic fallback; pass only usable candidates and validated ordering to `recommendAssignments`.

### 4. Wire core, protocol, and both hosts
- Add typed core handlers for the new setup probe lifecycle and route them through `Core.dispatch`.
- Extend `packages/protocol/src/index.ts` with strict request/result contracts, update protocol tests, and ensure unknown fields do not break older hosts.
- Forward the new messages in `hosts/vscode/src/extension.ts` and `hosts/jetbrains/.../WebviewRouter.kt`; add host routing tests for start/status/cancel and result shaping.
- Ensure core emits progress/status updates through the existing host event path or returns pollable state, without blocking the UI thread. Cancel must be idempotent and safe after completion.

### 5. Wire setup recommendation to probe outcomes
- Change recommendation input/state so it receives the ordered green candidate list and evaluator ranking, rather than implicitly probing every model again.
- Ensure rules mode can run immediately with green candidates; AI mode uses the selected evaluator only if it is itself green or explicitly allowed as evaluator, with deterministic fallback and existing hard-requirement validation.
- Keep orange/red candidates out of assignments by default. Preserve their diagnostic reason in the UI and logs without exposing secrets.
- Ensure “Accept and continue” with zero green candidates produces a clear recoverable setup state and does not silently assign unusable models; offer retry/back/channel configuration.

### 8. Update documentation and architecture notes
- Update `docs/ai_docs/SETUP.md` with the quick-probe lifecycle, 30-second bound, statuses, provider-first ordering, evaluator ranking, early accept semantics, and separation from optional benchmarking.
- Update `docs/ai_docs/ARCHITECTURE_NOW.md` in the same change for the new protocol methods, core runner ownership, host forwarding, and setup recommendation inputs.
- Update relevant module READMEs only where the public setup/channel contract changes.

## Verification
- Unit tests: timeout produces orange; HTTP/auth/malformed/empty response produces red; valid minimal response produces green; cancellation stops queue and in-flight request; duplicate candidates are skipped; one-at-a-time scheduling is enforced.
- Ordering tests: Ollama before Claude before other providers; evaluator ranking only affects non-local candidates; ranking timeout/failure falls back deterministically; unknown model IDs are ignored.
- Recommendation tests: only green candidates are eligible by default; orange/red are excluded with reasons; evaluator ranking failure still permits rules assignment; AI evaluator choices are validated.
- Protocol/host tests: VS Code and JetBrains forward start/status/cancel and return correctly shaped results; no route blocks the UI synchronously.
- Webview tests: all three statuses render with accessible labels; running/queued states are distinct; “Accept and continue” stops further requests and advances with partial results; retry/back behavior works; no duplicate probe requests after rerender.
- Focused commands: `pnpm --filter @stewart/setup test`, `pnpm --filter @stewart/core test`, `pnpm --filter @stewart/webview test`, protocol tests, VS Code host tests, JetBrains `./gradlew test` for routing if changed, then `pnpm -r typecheck` and relevant coverage/layer checks.
- Manual smoke: configure Ollama + one OpenAI-compatible channel + Claude CLI if available; verify local models appear first, one request runs at a time, a deliberately slow model turns orange at 30 seconds, accept-and-continue advances promptly, and recommendation uses only green models.

### 6. Add the webview quick-probe experience
- Show queued, running, green, orange, and red states with accessible labels and short reasons; keep existing capability badges as secondary detail.
- Put “Accept and continue” at the top of the probe step. It cancels future work, aborts the current request, records partial results, and advances without waiting for the queue.
- Start the queue once when the step opens, not from a render effect that can refire. Reuse cached completed results and avoid duplicate requests after state updates.
- Allow retry for orange/red candidates after setup or via an explicit retry action; do not silently re-probe all models on every render.

## Risks and mitigations
- Provider APIs may ignore abort signals: enforce an outer promise timeout and cancel the request signal; never let the scheduler wait indefinitely for a hung adapter.
- Ranking by an unreliable evaluator could hide useful models: ranking affects order only, omitted candidates are retained, and smoke-test outcomes determine eligibility.
- Early acceptance may leave most candidates untested: show skipped count and reasons, allow a later retry, and make clear that recommendation uses only completed green results.
- Existing benchmark cache could be mistaken for smoke success: use a separate smoke-result cache/version and do not infer green from capability or performance cache entries.
- Channel breakers and rate limits may make early candidates fail: preserve existing backoff semantics, avoid tight retries, and let the queue continue to later candidates where safe.
- The worktree currently has unrelated user changes (`AGENTS.md`, `docs/health_reports/`); implementation must not overwrite or include them without instruction.

## Open questions
- None blocking. The selected behavior is: all channel models are candidates; Ollama and Claude are probed first; the evaluator ranks remaining candidates; green/orange/red reflect the bounded smoke result; accept-and-continue permits partial results.

## Appendix: Additional acceptance criteria

- **Deadline semantics:** Start the 30-second candidate deadline when the scheduler admits that candidate; bound the provider request through response parsing. Track queue wait separately so queued candidates do not time out before they start.
- **Run ownership and stale work:** Maintain one active queue per project. Associate it with a run ID and a snapshot/fingerprint of enabled channels, models, and evaluator. Make repeated starts for the same run idempotent; when configuration changes or the project detaches, cancel in-flight work and prevent late results from updating a newer run.
- **Restart and cache validity:** Reuse only completed results whose candidate/config fingerprint matches. Treat persisted `running` candidates as interrupted after restart, never as green; make their retry behavior explicit.
- **Terminal-state races:** Ensure timeout, cancel/accept, and provider completion can produce only one terminal result. Ignore late provider results after timeout/cancel. If an adapter does not honor abort, define how the scheduler prevents overlapping requests while still avoiding a permanently blocked queue.
- **Skipped and retry states:** Represent skipped candidates explicitly in protocol, state, UI, and counts. Retries must be explicit and bounded; preserve prior attempt diagnostics without silently restarting completed probes.
- **Safe diagnostics:** Normalize user-visible failure reasons and redact secrets, authorization headers, and raw provider response bodies from results, events, and logs.
- **Lifecycle tests:** Cover simultaneous starts, project isolation, configuration changes during a run, restart with an in-flight candidate, cancel/timeout/completion races, and adapters that ignore abort signals.

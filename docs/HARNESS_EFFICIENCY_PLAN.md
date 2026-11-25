# Harness efficiency plan (proposed)

Basis: `docs/investigations/SLOW_RUNS_2026-11-25.md` (run-7: 8046 s, 660 requests, 82% reasoning tokens, 53 compactions = 16% of model time, prompts up to 55k tokens against a 32k window, repeated file re-reads).

Goal: cut wall time of long build runs on small-window reasoning models by at least half without lowering task pass rates. Prove it with the eval suite, not feel.

## Code facts (verified)
- `modules/channels/src/openai.ts` `chatBody` sends no `effort`/`think`/reasoning field, so `effort: medium` never reaches an openai-compatible model.
- `modules/session/src/compact.ts`: threshold `0.6 × window` (32,768 when unknown) on a 4 chars/token estimate; `KEEP_TAIL = 8`; a within-turn range is summarised only when it frees ≥ half the estimate; summary is one model call.
- `modules/engines/src/nativeLoop.ts`: `OUTPUT_CAP = 20_000` chars per tool result, regardless of window.

## Steps (build in order; each ships tests, positive + negative)

### E1. Measure first (small)
Add `scripts/analyze-debug-log.mjs` (the throwaway analysis from the investigation): per run — model time, reasoning vs content tokens, compaction count/time, repeat reads, top slow requests. Record the 2026-11-25 baseline in `docs/ai_docs/EVALS.md`. Every later step reports before/after with it.

### E2. Reasoning control for openai-compatible channels (biggest win)
- Pass reasoning depth on the wire: a per-channel `reasoning` config in `channels.yaml` naming the request field (`reasoning_effort`, `chat_template_kwargs: {enable_thinking}`, or `none`), since proxies differ. Default `none` = today's behaviour.
- Map `think === false` to the off field and `effort` low/medium/high to the effort field, mirroring the Ollama rules in ARCHITECTURE_NOW (`think:false` is the hard off-switch).
- Probe once per channel/model: send a trivial request with the field, check `reasoning_tokens` in `usage` drops; store the result in `modelCaps` (`reasoningControl: true|false`). Never send the field when the probe says unsupported.
- Routine-turn policy in the native loop: after a tool result that needs no planning (read/search/list outcomes), request `think:false`/low; full effort on the first turn of a task, after a failed tool call or failed check, and for the final report. Role override `role.think` stays authoritative.
- Add a per-request reasoning budget guard: if reasoning chars exceed N (default 20k) with no content/tool call, log `reasoning_overrun` and, once per run, retry with thinking off.
- Exit criterion: reasoning share of completion tokens ≤ 40% on the replayed run-7 task; pass rate unchanged.

### E3. Compaction that fits the window (second win)
- Trigger on measured `usage.in` from the previous response (fall back to the estimate before the first response); threshold 0.6 × window.
- Compact the kept tail too: before summarising, truncate old tool results (older than the last 4 messages) to head+tail stubs (e.g. 1,500 chars) in the outgoing copy; archive keeps originals.
- Hysteresis: one pass targets ≤ 40% of window; if the result is still above 60% after summary, run a second tail-trimming pass instead of another model summary next request.
- Cooldown: no new model summary within 4 requests of the last one unless the estimate exceeds 90% of the window.
- Summary template keeps a `Files read` digest (path + one-line purpose + key symbols) so re-reads are not needed.
- Exit criterion: no request over window; compactions ≤ 1 per 15 requests; compaction ≤ 5% of model time.

### E4. Window-aware tool output caps
`OUTPUT_CAP` becomes `min(20_000, window × 4 × 0.08)` chars (≈10k at 32k). `ReadFile` on large files returns a head window with an explicit `[truncated, use start/limit]` note, so the model reads ranges rather than whole files. Test both caps and note text.

### E5. Re-read guard
Track `path → last content hash + range` per run in the native loop. A repeat `ReadFile` of an unchanged file already in context returns `[Stewart] already read at turn N; unchanged` plus the digest line, and only re-reads when the file changed (tracker/write records) or the prior read was compacted away. Negative test: changed file re-reads in full.

### E6. Exploration discipline
- System-prompt rule for the lead: use `Search`/`FindFiles` over shell sweeps; no loops over every jar/file with `unzip`/`find -exec`; batch independent reads in one turn (`parallel: true` tools already run concurrently).
- Loop-guard extension: flag ≥ 5 `RunTerminal` calls on the same directory prefix within 20 turns with a `[Stewart]` nudge to summarise findings or ask the user.
- Add an `ask_user`/stop-with-report threshold for exploratory runs: if > 40 turns pass without a write, emit a one-line progress note and re-plan.

### E7. Lead/agent selection for long runs
- Warn in setup/Settings when a role's agent has a qualified window ≤ 32k and `turnBudget` > 40.
- Re-probe context on `models.refresh` (it may exceed the recorded 32000); show the probed value in the agent row.
- Optional per-role `heavyAgent` hand-over: long build/plan runs start on the larger-window agent. Reuse the divert machinery (`DEEP_THINK_DIVERT_PLAN.md`) rather than a new path.

## Docs and gates
Update `docs/ai_docs/ARCHITECTURE_NOW.md` (compaction rules, channel reasoning config, caps, re-read guard) in the same commit as each step; keep `check:functions` limits (compact.ts is at 188 lines; split trimming into `compactTrim.ts`). Update `docs/ai_docs/DEBUG_LOGGING.md` if new log tags (`reasoning_overrun`) are added, and `PROGRESS.md` per milestone.

## Verification
- Unit tests per step (positive + negative), coverage per package unchanged.
- Replay: a fixed build task (the Node-fetch fixes) on `AIF-qwen3-8-27b` before and after; compare with E1 script: wall time, reasoning share, compactions, repeat reads, tests green.
- Eval suite (`packages/evals`) must not regress, especially tasks that need deep reasoning (E2 policy must not starve them).

## Risks
- Turning reasoning down can lower quality on hard turns; mitigated by full effort on first turn, after failures and for reports, and by the overrun retry.
- Provider reasoning fields are non-standard; the probe plus `none` default keeps unknown proxies unchanged.
- Aggressive truncation can hide needed content; stubs keep head+tail and the archive keeps originals.

## Expected impact (to be confirmed by E1 measurements)
E2 attacks ~5,400 s of 6,600 s model time; E3–E5 remove ~1,000 s of compaction plus re-read turns; E6–E7 cut turn count. Target: run-7-class task from ~2.2 h to under 1 h.

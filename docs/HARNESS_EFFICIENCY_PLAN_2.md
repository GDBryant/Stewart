# Harness efficiency plan 2 (built F1–F3; F4 not built; replay pending)

As built: `ARCHITECTURE_NOW.md` §3j. Deviations: F1 retries only on full runs (`maxTurns >= 10`) and only before any output; F2 is advisory (a badge, no config write, no Settings warning); F3 adds a `health_batches` tool (the planned no-scope `health_report` was wrong: it only merges delegated reports) and the stray-file report is not built.

Source: `~/.cache/JetBrains/PyCharm2026.3/log/stewart/debug_logs/2026-11-26.log` (full logging, 18 model requests, 1 run, 07:18–07:26 UTC; the log ends with the run paused on the user's approval of the Claude CLI question, not a failure), task "check the code health of this project and save results into docs/health_reports/". Lead on `AIF-qwen3-8-27b`, built through plan 1 (`HARNESS_EFFICIENCY_PLAN.md`, E1–E7). Analysed with `scripts/analyze-debug-log.mjs`.

Only one short run exists, so this plan covers what that run proves; it is not a replay of the run-7 baseline. The E3–E6 effects (compaction, re-read, exploration nudges) were not exercised: 0 compactions, max prompt 18.3k tokens, 0 `exploration_nudge`/`reasoning_overrun` lines.

## Observed
| # | Observation | Evidence |
|---|---|---|
| O1 | Run died on one request: 240 s, zero streamed chunks, `HTTP 504 GatewayTimeout`. Prompt was only ~17–18k tokens. | only `[error]` line in the log, request 17 (07:21:59→07:25:59) |
| O2 | A transient 504 went straight to a model escalation (`run.escalated … reason:"error"`, `AIF-qwen3-8-27b` → `claude-sonnet`), then an `ask_user` approval gate for the Claude CLI channel, which paused the run awaiting the user (the log ends there). A user-visible stop after one transient 504. No same-model retry. | log lines 12354–12355; `taskRun.ts` sets `ts.reason="error"` on any engine throw |
| O3 | E2 is inert on this channel: request body has no reasoning field (only `stream`, `stream_options`), so reasoning is still 74% of 12,860 completion tokens (per request 40–95%). | `channels.yaml` has no `reasoning:`; default is `none` and nothing prompts the user to set it |
| O4 | The lead never called `health_report` (whole-project health via parallel auditors, the purpose-built path). It hand-built its own batching: `find`/`awk` shell sweeps, wrote `/tmp/pack.py` then `.pack_health.py`, read `.health_batches.txt` in ranges. 17 requests spent before any audit started; the stray files are left in the repo root. | tool calls: `ListCodeFiles`, 3× `RunTerminal`, 2× `WriteFile`, 4× `ReadFile`; no `health_report`/`delegate` |
| O5 | Prompt grew 4.4k → 18.3k tokens in 16 requests (4× growth), driven by dumping a 657-line batch listing into context via `ReadFile`. | `prompt_tokens` series |
| O6 | Time: 207 s model time over 17 good requests, avg 12 s; two requests of 25–43 s were reasoning-dominated (e.g. 2,742 completion tokens, 2,211 reasoning, to emit a tool call). | analyzer + per-request tokens |

Not a cause: compaction, window overflow, loop guard, repeat reads (2 only).

## Cause (O1)
Not proven. A prompt of 18k tokens is not oversized for the model, and the proxy streamed 1,900+ chunks on earlier requests, so this looks like a backend stall or proxy 230–240 s first-byte timeout. The log cannot tell queueing from long hidden reasoning (the proxy emitted nothing). What is certain is the harness response: no retry, and a stall-timeout (`stallTimeoutMs` 60 s) that only guards gaps after streaming starts, so a request waits the full proxy limit with no first-token deadline.

## Steps (build in order; each ships positive + negative tests)

### F1. Transient-error retry before escalation (fixes O1/O2)
- Classify provider errors in `openai.ts`: 408/429/5xx, connection reset and first-token timeout are `transient`; 4xx auth/bad request are not.
- `nativeLoop`/`modelTurn`: on `transient`, retry the same request up to 2× with backoff (2 s, 8 s), logging `retry: <status> attempt n` to the host log. Only after retries fail does the run finish `error` and escalate.
- First-token deadline: `firstTokenTimeoutMs` (default 90 s for reasoning-capable models, window-scaled) aborts a request that has produced no chunk, treated as `transient`. Distinct from the existing 60 s inter-chunk stall.
- Escalation after retries fail keeps the existing chain and its Claude CLI approval gate (working as designed); with F1 it is reached only for real failures.
- Exit criterion: injected 504 on one request does not change the model; two consecutive failures do.

### F2. Make E2 reachable (fixes O3)
- The reasoning field defaults to `none`, so a correctly built E2 does nothing for existing channels. When the channel probe sees `reasoning_tokens > 0` in `usage` and no `reasoning` is configured, set `reasoning` automatically after the existing off-field probe (try `reasoning_effort`, then `enable_thinking`), store the result in `channels.yaml`, and show it in the channel editor. Never send an unproven field: the probe stays the gate.
- Surface "reasoning is not controllable on this channel" as a Settings warning when probing both fields fails.
- Exit criterion on a replay of this health task: reasoning share ≤ 40%; no 25–43 s tool-call turns.

### F3. Route "health" tasks to `health_report` (fixes O4/O5)
- Lead prompt (`session/lead.ts`): when the request asks for a project or folder code-health check, call `health_report` first; do not enumerate or batch files by hand. Add to `EXPLORATION_RULES`.
- Guard: a lead run that writes a helper script (`*.py`/`*.sh`) to a temp or repo-root path as a first-hour step gets a `[Stewart]` nudge naming `health_report` and `delegate` (reuse `exploreGuard`; no trip).
- `health_report` should accept being called with no scope (default = whole workspace via the inventory it already has) so the tool is cheaper than the hand-rolled path. Check `modules/tasks/src/healthContract.ts` for the current required arguments before building.
- Hold stray files: a `WriteFile` to the repo root by an audit-style role is flagged in the final report (list of created files).
- Exit criterion: first `health_report` call within 3 requests; no helper scripts created.

### F4. Keep large listings out of context (O5)
- `ReadFile` result cap (E4) already bounds one result, but ranged reads of one big file accumulate. Add a per-file cumulative-read budget (e.g. 3× the cap) per run: past it, the result says to use `Search` or `delegate` instead. Low priority; measure after F3 because F3 removes the source.

## Docs and gates
`ARCHITECTURE_NOW.md` §3j (retry classification, first-token deadline, auto reasoning probe, lead rule), `DEBUG_LOGGING.md` (`retry:` host-log tag), `PROGRESS.md`; keep `check:functions` limits; coverage per package unchanged.

## Verification
- Unit: fake channel returning 504 then 200 (retry succeeds), 504 ×3 (finishes `error`), 401 (no retry), no-chunk hang (first-token deadline), probe with and without `reasoning_tokens`.
- Replay: same prompt on `AIF-qwen3-8-27b`; compare with the analyzer (`requests`, `reasoning %`, `health_report` call turn).
- Still outstanding from plan 1: a long run (run-7 class) is needed to confirm E3–E6; this log does not cover them.

## Risks
- Retrying a request that did start generating can double-bill; only retry when no chunk arrived or the HTTP status is 5xx before the stream.
- Auto-writing `reasoning` into `channels.yaml` changes user config; ask first through the existing probe/`ask_user` flow instead of silently writing.
- Routing health tasks to `health_report` must keep the lead able to do a narrow "check this file" review without the full pipeline.

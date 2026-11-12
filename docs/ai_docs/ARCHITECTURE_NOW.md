# Stewart — Architecture Now

Living description of the code **as it is**. Update in the same commit as any change to modules, run paths, protocol, config, or host wiring. Plans live elsewhere (`docs/building/` = active; `docs/archived_v2/` = superseded v2-era docs).

Last updated: 2026-11-12 (v3 cut-over; history: `git log -- docs/ai_docs/ARCHITECTURE_NOW.md`).

## 1. Layout

```
packages/
  protocol/    JSON-RPC types, PROTOCOL_VERSION, capability negotiation (src/index.ts)
  core/        all logic; no host imports
  sidecar/     Node stdio JSON-RPC server for JetBrains (rpc.ts, server.ts, host.ts reverse-RPC → HostPort, debugSink.ts)
  webview/     Preact chat + settings + setup wizard, one bundle for both hosts
  evals/       outcome eval suite: fixture repo, code-scored tasks, Node HostPort runner over a real Core (docs/ai_docs/EVALS.md)
modules/       17 `@stewart/<module>` packages, each with a `README.md` (purpose, surface, owns, deps). Modules import only strictly lower layers (`scripts/layers.json`, `pnpm check:layers`); every package is `composite` with a 90/80 coverage gate. Product version 3.0.0 (`hosts/vscode/package.json`, `build.gradle.kts`). Layers: see table in §1a.
hosts/
  vscode/      in-process core; host.ts implements HostPort via vscode API; routes.ts = webview message route table + dispatchAndReply
  jetbrains/   Kotlin: SidecarSupervisor (bundled Node, restart/backoff), HostRequestHandler, JCEF WebviewRouter
```

```
webview ─postMessage─ host ─(in-process | stdio NDJSON JSON-RPC)─ Core.dispatch
                                                                    │
                                                 ConfigStore    ChannelService   SessionService ─→ Engine
                                                 (YAML, schema) (adapters)       (lead turns)      ├ native-loop ─→ channel.chat
                                                                                                   └ claude-code ─→ Claude Code CLI
```

### 1a. Module table

| Module | Layer | Purpose |
|---|---|---|
| `kernel` | 0 | Wire types, ports, EventBus and in-memory test fakes every other module builds on |
| `catalog` | 1 | Bundled model price/limits data and model-name normalization |
| `diagnostics` | 1 | Debug log: leveled sink, redaction, retention, RunEvent entries |
| `models` | 2 | One merge of caps/probe/bench/catalog/price into a `ModelProfile`; `ProbeLoop`/`ProbeRequest`/`ProbeResult` types |
| `config` | 2 | YAML config files: schema, three-layer merge, store, SelfWriteGuard |
| `interaction` | 2 | The one owner of user-facing prompts: a FIFO queue showing one card at a time, with typed `Prompt<A>` and timeout/abort withdraw |
| `channels` | 3 | Provider adapters plus the managed policy wrapper and registry; claude-cli adapter serves login/models/caps only (its `chat()` throws — claude-cli runs via the claude-code engine); `nodeSpawn`/`SpawnFn`/`claudeChildEnv`/`classify` shared with the engine |
| `code-health` | 3 | Code-health report types, batching, aggregation, rendering (kept for step-3 delegated roles) |
| `ledger` | 3 | Append-only cost ledger and per-run cost cap |
| `permissions` | 3 | Approval categories, grants, tool previews, shell program splitter, approval gate |
| `roles-skills` | 3 | Role and skill definitions, validation, prompt composition, effective config (`loadEffectiveConfig`); shipped roles = `lead` + read-only `explorer`/`reviewer`; old role ids (orchestrator, general-worker, …) load as inert profiles |
| `context` | 4 | Prompt context: @mentions, image attachment limits, project context files (`loadProjectContext`) |
| `tasks` | 4 | Code-run acceptance checks (`turnCheck`, `runCheck`): failed writes, required files, command exit, empty reply, `cites` (reply file citations must exist), `schema: "health"` (```json block validating as `HealthReport`) |
| `tools` | 5 | Tool registry, built-in tools, role guards: `writePaths` enforcement and the read-only terminal guard for roles without write tools |
| `engines` | 6 | `Engine` contract (`run(turn) → AsyncIterable<EngineEvent>`), `nativeLoop` (native tool calling, no text shim), `claudeCode` (Claude Code CLI as a supervised full agent), `engineFor` |
| `setup` | 7 | Setup wizard: model discovery, quick probes, benchmark, rules + AI assignment, `SetupSession` draft/approve/undo state machine |
| `session` | 7 | `SessionService`: persisted sessions/transcripts (`ChatHistoryStore`), lead turns, `ChildRunner` delegation (`delegate`/`health_report`, depth 1, cap 4), engine state, ledger metering, checks, cancel |

## 2. Surface map

| Surface | Owner | Notes |
|---|---|---|
| Protocol | `@stewart/protocol` | METHODS map, `runEventSchema` (run/task/milestone/tool/approval/cost/check/history events; `run.finished` status `done\|failed\|cancelled`), PROTOCOL_VERSION, capability negotiation |
| Config | `@stewart/config` (+ `effective.ts` in `roles-skills`) | YAML + zod schema (unknown/old keys strip — old settings.yaml parses), shipped < user < project merge by id, `SelfWriteGuard`; role schema drops `fallbackAgent` but accepts it in old files |
| Channels | `@stewart/channels` | Adapters (ollama, claude-cli, …), `ManagedChannel` (retry/backoff, `chat`, `probe`), `ChannelService` registry |
| Tools | `@stewart/tools` | `ToolRegistry` (validate, `for(role)` filtering, `writePaths`, read-only terminal guard), built-ins (files, search, terminal, images, CodeMetrics), session tools `load_skill`/`ask_user` added by SessionService |
| Engines | `@stewart/engines` | §3a |
| Checks | `@stewart/tasks` | §3a |
| Setup | `@stewart/setup` | rules + AI assignment over the shipped role set (`lead`), benchmarks; `ProbeLoop` for bench is built in `packages/core/src/probeLoop.ts` from `nativeLoop`: one-shot synthetic tool call, toolOk when the probed tool's outcome arrives |
| Model facts | `@stewart/models` `profile.ts` | `resolveModelProfile`/`profileFromChannel`: caps, toolsMode, perf, price (agent > live > catalog), cost tier, `contextTokens`; `mergeProbeCaps` (user > probe); `capsFor`/`userCaps` guard raw `modelCaps` reads (`check:boundaries`) |

## 3. Run paths

There is exactly one chat path: the lead session.

### 3a. Lead path

`handleChatSend` (no `/direct`, no orchestrated path, no classifier) resolves the enabled `lead` role and calls `ProjectCtx.sessions.send`. `SessionService` (`@stewart/session`) loads the `ChatHistoryStore` transcript + `<stateDir>/sessions/<id>.engine.json`, appends the user message, resolves the lead agent (`lead.agent` else the first configured agent — clear error when none), builds the system prompt (lead prompt + one-line skill index + `loadProjectContext` cut to 8000 chars) and tools (`projectTools(...).for(lead)` + `load_skill` + `ask_user` via `interaction.questionPrompt` + `delegate` + `health_report`), then runs `engineFor(channel type)` — `claude-code` for `claude-cli` channels, `native-loop` for everything else. `maxTurns` = `lead.turnBudget` (`unlimited` → 200).

The session emits `run.started`, `text_delta`/`reasoning_delta`, `tool.request`/`tool.outcome` (roleId `lead`); approvals route through `permissions.gate` so `chat.approve`/`chat.answer` keep working; usage meters into `RunLedger` (role `lead`) with `cost.summary` when cost > 0 and abort + failed "cost cap reached" past `costLimit.perRunUsd`. After the engine stops the session runs `@stewart/tasks` `runCheck(turnCheck(input))` — failed writes, files that must exist, optional command, empty reply — emits `check.result`, and finishes `done` only when the engine stopped normally **and** the check passed (`cancelled` on cancel, else `failed` with the engine error or check evidence). Transcript + engine state persist after every turn, including failures. `chat.cancel` → `sessions.cancel`. Turns on one session serialize.

### 3b. Engines

`native-loop` (`engines/nativeLoop.ts`): per model turn `channel.chat` with native `tools` (no text shim), streams text/reasoning/usage, appends assistant/tool messages to the transcript, executes calls sequentially — consecutive calls on tools flagged `parallel: true` run concurrently via `Promise.all`, preserving tool-message order — (validate → preview → `approve` → 120 s timeout — skipped for `awaitsUser` tools — 20k-char 70/30 cap, image results pushed as user image messages), emits `write` records for WriteFile/EditFile/ApplyPatch, finishes `stop`/`turn_limit`/`cancelled`/`error`.

`claude-code` (`engines/claudeCode.ts`/`claudeLines.ts`) spawns the Claude Code CLI as a full agent in the project root: `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --include-partial-messages --model <normalizeModel(agent.model)>` plus `--append-system-prompt` (non-empty system only), `--max-turns`, and `--resume <state.cliSessionId>` when stored. It uses the CLI's own tools — `turn.tools` is ignored — under `claudeChildEnv` (host env minus `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, plus `cfg.extraEnv`). The last user message goes to stdin as one stream-json line (images as base64 blocks); stdin stays open for control traffic, closed after `result`. `can_use_tool` control requests route through `turn.approve` with a mapped preview (Edit/Write/MultiEdit/NotebookEdit → file preview relativised to cwd, Bash → command, others → `OTHER`); other control subtypes get an error response. Deltas dedupe by `api_message_id`; `tool_use`/`tool_result` → `tool.request`/`tool.outcome` + `write` records from `tool_use_result.filePath`; `system.init.session_id` → `state.cliSessionId`; `result` → `usage` (input+cache tokens, `total_cost_usd`) then `finished` (`error_max_turns` → `turn_limit`). Cancel → `interrupt` control_request then kill tree after 3 s. Exit without `result` → stderr tail via `classify` (auth → "Claude CLI not logged in"). Stale `--resume` clears the id and retries once with a ≤6-message ≤4000-char recap. Verbatim stream-json captures in `modules/engines/test/fixtures/`.

### 3c. Setup bench probe

`channel.probe --bench` (`packages/core/src/probeLoop.ts`) runs `nativeLoop` with one synthetic tool and an auto-approve gate; it aborts the turn the moment the probed tool's outcome arrives, so `toolReliability`/`editOk` measure "did the model issue a valid native call" in one round trip; `jsonOk` comes from a plain chat probe. Unknown measurements warn instead of hard-failing recommendations.

### 3d. Delegation

`delegate({role, task, report?})` (lead only, `parallel: true`) runs a child turn: agent = `role.agent` else the lead's resolved agent; engine via `engineFor` (same engine id, incl. `claude-code`); tools = `projectTools(...).for(role)` + `load_skill` (children never get `delegate`/`health_report` — depth 1); system = role prompt + skill index + project notes; transcript = the task as one user message; `maxTurns` = `role.turnBudget`; up to 4 children run concurrently. Read-only roles (no write tools) get the generic read-only terminal guard; for `claude-code` children the same guard is applied in `childApprove` (file previews and mutating commands are rejected before the gate). Each child gets the `tasks` `turnCheck` plus `cites: true` (reply `path:line`/`path` citations must exist) and, for `report: "health"`, `schema: "health"` (exactly one ```json block validating as `HealthReport`, all report paths must exist). Status is `done` iff engine stop + check passed; the delegate result text is `status: <s>` + the reply (8k cap) + `check: <evidence>` on failure — a failed child is a tool success, not an error. Events: `task.created`/`task.started`/`task.done`/`task.failed` with `taskId`+`roleId`; child text/tool rows carry `taskId`; usage meters to the ledger under the child role and counts toward the run cost cap. Child transcripts save to `<stateDir>/sessions/<sessionId>/<taskId>.json` (not in the history list). `health_report()` merges successful `report:"health"` children via `@stewart/code-health` (`mergeReports` + `aggregate` + `renderReport("issues", ...)` + `scanMetrics`/`summarizeMetrics`), writes `.stewart/reports/health-<runId>.md` through the host, returns the rendered text + path; fails "no health reports in this run" when empty. Shipped roles: `lead`, `explorer` (read-only search), `reviewer` (read-only review); `project-health` skill on the lead orchestrates batched reviewer runs.

## 4. Model facts

Per `channel/model`, facts come from: `modelCaps` in `channels.yaml` (user, wins) ← probe cache (in-memory) ← bench `perf` ← catalog / live `priceList`; agent `price` wins for cost. `models/profile.ts` is the single merge; raw `modelCaps` reads go through `userCaps`/`capsFor` (`check:boundaries` forbids raw reads outside the allowlist).

## 5. Config and state

- Files: shared `~/.config/stewart/{channels,agents,roles,settings}.yaml`, `skills/` — one dir for every IDE and project (`@stewart/config` `userDir.ts`; Kotlin mirror `UserConfigDir.kt`). Created on host start. Files must be `.yaml`; project `.stewart/{roles.yaml,skills/}` (trusted workspaces only). Old keys (budgets, recovery, lease/plan settings, `fallbackAgent`) parse and are ignored.
- State dir (HostPort): `ledger.jsonl`, `sessions/<id>.engine.json`, chat history (`ChatHistoryStore`, owned by `@stewart/session`), setup drafts (`setup-draft.json`, 7-day expiry).
- `files.*` path contract (both hosts): absolute paths used as-is; relative paths resolve under the workspace root. `files.list` returns `dir`-prefixed relative paths.
- Secrets via HostPort only (`secretRef`).

## 6. Known gaps

- Step 4 (model chains with escalation) is not built: children use `role.agent` else the lead's agent — one model per turn, no chain. `milestone.*`/`run.reverted` events are kept in the protocol for step 5 but nothing emits them yet.
- No plan/checkpoint resume or revert (`chat.resume`/`chat.revert` removed; step 5 re-adds them).
- No context compaction or long-build support yet (step 4/5).
- Claude CLI `chat()` is intentionally unsupported (claude-code engine owns that transport); listModels/loginStatus/probeCaps remain for setup.

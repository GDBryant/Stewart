# Stewart v2 — Architecture Plan (rebuild)

Status: proposal, 2026-11-04. Source: `docs/future/todo` + lessons from Stewart v1 (`docs/*.md`).
Decisions taken: **one TypeScript core** shared by VS Code (in-process) and JetBrains (Node sidecar + JCEF webview); launch channel types **OpenAI-compatible, Ollama, Claude Code CLI**. ACP CLI agents are a later channel type. Webview UI: **Preact**. Project config loads only in trusted workspaces. Orchestration is automatic when the Orchestrator role is enabled. Parallel writes use per-file leases. Nested `ask_user` routes via the Orchestrator. Role context is fresh per dispatch. First run is a setup wizard.

## 1. Goals
- Channels are configurable instances, not hard-coded providers. Any type can be added many times (e.g. two OpenAI-compatible channels: AI Factory and NVIDIA NIM).
- Agents = channel + model + parameters. Roles are tick-box enabled and get an agent assigned.
- Skills are files in a config folder, assignable per role, with shipped defaults and reset.
- A cheap, fast **Orchestrator** routes all work to roles; it does no heavy work itself.
- Same behaviour on JetBrains (2026.1+, all IDEs) and VS Code.

## 2. Layout (pnpm monorepo)

```
packages/
  core/        TS, no host imports: channels, agents, roles, skills, orchestration, tool loop, tools (logic), permissions, history, logging
  protocol/    JSON-RPC types shared by core, hosts and webview (versioned)
  webview/     chat UI + settings UI (one bundle for both hosts)
  conformance/ recorded fixtures from v1 (Ollama NDJSON, OpenAI SSE, Claude stream-json, tool-call formats)
hosts/
  vscode/      extension: activates core in-process, WebviewPanel, HostPort via vscode API
  jetbrains/   thin Kotlin plugin: launches bundled Node sidecar, JCEF webview, HostPort via platform API
```

```
 webview (chat, approvals, settings) ──postMessage──┐
                                                    │
 host (VS Code ext | JetBrains Kotlin) ── JSON-RPC ─┤── core
   implements HostPort                              │     ├─ ChannelRegistry → Channel adapters
                                                    │     ├─ AgentRegistry, RoleRegistry, SkillStore
                                                    │     ├─ Orchestrator → RoleRunner → ToolLoop
                                                    │     └─ ToolRegistry → validate → approval → HostPort
```

### HostPort (the only host-specific surface)
| Capability | VS Code | JetBrains |
|---|---|---|
| Secrets | `SecretStorage` | `PasswordSafe` |
| Read / versioned edit, one undo step | `WorkspaceEdit`, `TextDocument.version` | `WriteCommandAction`, `Document.modificationStamp` |
| Post-write read-back | re-read file | re-read file |
| Diff preview | `vscode.diff` | `DiffManager` |
| Process run (stream, cancel, tree kill) | `child_process` | `GeneralCommandLine`/`OSProcessHandler` |
| Proxy + CA certs (HTTP and child env) | `http.proxy` + explicit agent | `JdkProxyProvider`, `CertificateManager` → env |
| Diagnostics, symbols | `languages.getDiagnostics`, symbol providers | `DaemonCodeAnalyzer`, PSI |
| Editor selection, "Add to chat" | commands + context menu | actions in `plugin.xml` |
| Workspace roots, state dir | `workspaceFolders`, `storageUri` | `ProjectRootManager`, system dir |

Core never touches the filesystem for project edits directly; it asks HostPort, so undo, unsaved buffers and stale checks stay native.

### Test seams and extension points
- Core takes injected `Clock`, `IdGen` and `Fetcher` (HTTP; fetch record/replay) alongside HostPort, so tests are deterministic and fixtures replay exactly.
- Channel types implement a `ChannelAdapter` interface registered in the `ChannelRegistry`; adding a type (e.g. ACP) touches no core code. Every adapter must pass the shared **channel contract suite** (§9).
- Orchestration verbs (`dispatch`, `ask_user`, `submit_*`) are registered in the same `ToolRegistry` as file tools, flagged `coreHandled`; new verbs need no schema change. Approval categories are an open set.
- `ToolRegistry` accepts external `ToolProvider` plugins (e.g. a future MCP stdio/SSE adapter) whose tools register dynamically under `MCP:<server>` (or `OTHER`) permission categories without core changes.
- The event bus (§11) has a defined subscriber API: async subscribers, no ordering guarantees, failures isolated from the run.

### Message routing
- Webview never talks to core directly. It posts to the host; the host forwards to core (in-process call in VS Code, stdio JSON-RPC in JetBrains). One protocol, two transports.
- High-frequency stream events (`text_delta`, `reasoning_delta`, `terminal_output`) are coalesced in core into 30ms frames per task before emitting over JSON-RPC / `postMessage`, preventing parallel tasks from saturating stdio or freezing JCEF/Webview; lifecycle and tool events flush immediately.
- Every request carries `projectId`; core keeps per-project state (config, history, runs, leases) and app-level state (channels, agents, secrets, ledger of all projects).
- Webview hardening: strict CSP (`default-src 'none'`, nonce scripts, no remote origins), no `eval`, messages validated against the protocol schema on both sides.

### Sidecar (JetBrains)
- Node runtime bundled (Node 22 LTS, pinned): the build emits one JetBrains zip per OS/arch (linux-x64, linux-arm64, windows-x64, macos-x64, macos-arm64), each with its own Node; no system Node required. stdio JSON-RPC only, no TCP port; handshake negotiates protocol version **and a capability list**, so minor skew degrades (feature off + notice) instead of refusing; an incompatible major version fails with an actionable error.
- Lifecycle: one sidecar per IDE process, multiplexed by project; restarted on crash with in-flight runs marked `failed: sidecar_crash` (resumable via `/resume`); child process trees killed on project close. Restarts back off exponentially; a crash loop (5 starts in 60s) degrades to an error state with restart/log actions rather than looping forever.
- Requirements: JCEF available (`JBCefApp.isSupported()`); otherwise the tool window shows an actionable message. Local IDEs only; remote development (Gateway) is unsupported in v2 and shows a notice.

## 3. Config model

All non-secret config is plain YAML files, identical on both hosts, validated against a JSON Schema shipped with core (also used for editor completion). Project files override user files field by field. Every file carries `version: N`; a migration function per version bump upgrades on load, so schema changes never break existing installs.

```
~/.config/stewart/            (Windows: %APPDATA%\stewart)
  channels.yaml   agents.yaml   roles.yaml   settings.yaml
  skills/<skill-id>/SKILL.md
<project>/.stewart/
  roles.yaml  skills/  scratch/  (scratch git-ignored)
```

Secrets are never in files: `channels.yaml` holds `secretRef: channel/<id>`, resolved through HostPort. The secret is entered in the Channels settings panel and written straight to the host secret store; the webview never receives it back.

Precedence: shipped defaults < user files < project files, merged field by field; list items merge by `id`. Project files (`.stewart/`) are read only in a trusted workspace (VS Code Workspace Trust, JetBrains trusted project); in an untrusted one they are ignored and the chat shows a one-line notice. Project files may carry `roles.yaml` and `skills/` only; `channels.yaml`, `agents.yaml` and secrets are user-level, so a repo cannot point an agent at a foreign endpoint.

Files are watched; edits apply on the next run. Invalid YAML or schema violations keep the last good config and surface the error in Settings. All config and state writes use atomic write-temp-and-rename plus content-hash self-write suppression so concurrent VS Code / JetBrains windows never corrupt YAML or trigger watch loops.

### Channel
```yaml
- id: aif
  type: openai-compatible        # openai-compatible | ollama | claude-cli  (later: acp)
  name: AI Factory
  enabled: true
  baseUrl: https://…/api/proxy/v1
  secretRef: channel/aif
  discoverModels: true            # GET /models, unioned with extraModels
  extraModels: []
  maxParallel: 4                  # default: ollama 1, others 4
  modelCaps:                      # overrides; otherwise probed or default
    qwen3-8-27b: { tools: native, vision: false, reasoning: true }
```
Capabilities per model: `tools` (native | shim | none), `vision`, `reasoning`, `imageGen`, `contextTokens`, `numCtx` (Ollama). Unknown tool capability → shim; unknown vision → no images.

Probe per type, run from "Test connection" and on first use, cached in app state with a timestamp and a "Re-probe" button:
- Ollama: `/api/show` capabilities (`tools`, `vision`, `thinking`), `context_length` from model info.
- OpenAI-compatible: one minimal chat call with a dummy tool; `tools: native` on a well-formed `tool_calls` reply, `shim` on text, `none` on HTTP 4xx naming tools. Vision and `contextTokens` from `/models` metadata when present, otherwise default (`vision: false`, 32k).
- Claude CLI: static table per model id; cost from `total_cost_usd`.

`maxParallel` bounds concurrent calls per channel; tasks beyond it queue. Rate-limit replies (429, `Retry-After`) back off per channel, not per task. Every call has a request timeout and a **stream stall timeout** (no chunk in 60s → classified TRUNCATED, handled by fault recovery). A circuit breaker per channel: 5 consecutive failures (not counting 429) mark the channel `unhealthy`, park its tasks and show a badge; a single success or "Test connection" closes it.

### Agent
```yaml
- id: fast-local
  channel: ollama-local
  model: north-mini-code-1.0
  effort: low                     # low | medium | high | max → turn budgets + provider effort fields
  temperature: 0.2
  billing: free                   # free | reported | priced | unmetered
  # price: { inPerMTok: 3.0, outPerMTok: 15.0 }   # only for billing: priced
```
`billing` defaults by channel type: Ollama `free`; Claude CLI `reported` (`total_cost_usd`); OpenAI-compatible `reported` when responses carry a cost field, otherwise `unmetered`; the AI Factory preset sets `free`. `priced` computes cost from token usage and the per-agent price the user enters. The Agents table shows a warning badge on `unmetered` agents, because the cost limit cannot see what they spend.

### Role
```yaml
- id: code-writer
  enabled: true
  agent: coder                    # agent id
  fallbackAgent: local-coder      # optional; used when primary agent's channel is unhealthy
  skills: [execution-contract, tdd, surgical-patch, tool-call-format]
  tools: [ReadFile, FindFiles, Search, GetProblems, EditFile, WriteFile, ApplyPatch, RunTerminal]
  turnBudget: 25
```
Each role ships a default (`core/defaults/roles.yaml`). When a role's primary agent channel trips its circuit breaker (`unhealthy`), dispatches fail over to `fallbackAgent` if set and capability-compatible (asking the user first if switching from `free` to `priced`/`reported`). Settings UI per role: **Reset to default**. Global: **Reset all roles** and **Assign default agent to all roles** (one chosen agent; skills/tools untouched).

### Skill
`SKILL.md` with frontmatter `id, description, defaultRoles, version`; body is injected into the role's system prompt (bounded). Shipped skills use copy-on-write: they are read from the bundle until edited in Settings (or overridden on disk), and user files record `baseHash` of the shipped version so unedited skills auto-upgrade on plugin updates while edited ones show an "Update available (diff)" badge. "Reset skill" removes the user override and restores the shipped text. User-created skills appear in every role's tick list.

## 4. Roles (defaults)

Orchestrator is required when any other role is enabled; all others are optional. A disabled role's work falls back to **General Worker**; if that is disabled too, the Orchestrator asks the user. Single-agent mode = one role (General Worker) on the chat-selected agent, no orchestrator.

Mode is automatic: Orchestrator enabled and bound → every message starts an orchestrated run; otherwise the message goes to the chat-selected agent. The chat header shows which mode is active. `/direct <message>` sends one message to the selected agent without orchestration (for quick questions).

"Default agent tier" is a hint shown in the agent dropdown (badge next to agents whose capabilities fit), never a binding. On a fresh install roles have no agent and stay disabled. **First run wizard**: add a channel → test connection → create an agent → "Assign to all roles" (enables Orchestrator + General Worker, leaves the rest off until the user ticks them). The wizard reappears from Settings → "Run setup".

| Role | Purpose | Default agent tier | Tools | Default skills (ticked) |
|---|---|---|---|---|
| Orchestrator | Reads the request, picks roles, dispatches, gathers results, answers the user. Never edits. | fast / cheap | `dispatch`, `ask_user`, `ReadFile`, `FindFiles` | orchestrate, delegate-briefing, ask-user |
| Planner | Goal + ordered milestones with acceptance criteria. | strong | read-only, `submit_plan`, `ask_user` | plan-breakdown, spec-first, ask-user |
| Plan Validator | Adversarial check of the plan against code and request; verdict approve / revise with reasons. | strong (different model than Planner when possible) | read-only, `submit_verdict` | plan-validate, doubt-review |
| Investigator | Locate code, trace causes, gather evidence; returns path:line findings. | fast | read-only, `GetProblems`, `RunTerminal` (read-only programs) | investigate-first, code-search, evidence-report |
| Architect | Module boundaries, interfaces, data shapes; writes design notes. | strong | read-only, `WriteFile` (docs only) | architecture-design, api-design, adr |
| General Worker | Any task not owned by an enabled role. | mid | all | execution-contract, verify-and-stop |
| Code Writer | Implements one task: edits + tests, verifies. | coder | all | execution-contract, tdd, surgical-patch, tool-call-format |
| Code Reviewer | Reviews a diff; one finding per line; no edits. | strong | read-only, `GetDiff` | code-review, security-review |
| Tester | Runs and writes tests, reports failures with evidence. | mid | all | tdd, verify-and-stop |
| Document Writer | Docs, READMEs, ADRs, changelogs; brief style. | mid | read-only, `WriteFile`/`EditFile` (docs paths) | docs-writing, adr, brief-style |
| Image Reader | Describes screenshots/diagrams for other roles (text out). | vision | `ReadImage` | image-describe |
| Image Writer | Generates diagrams/images (`/images/generations` or Mermaid/SVG fallback). | image-gen | `GenerateImage`, `WriteFile` (assets) | image-generate, diagram-as-code |

Common skill `execution-contract` (tool calls are data; validate → preview → approve → execute; no replay) is always applied to any role with write tools and cannot be unticked.

Role-level enforcement: tool lists are filtered in core, not just described in the prompt. A role cannot call a tool outside its list; `Image Reader` is only assignable to agents with `vision`, `Image Writer` only to `imageGen` (or falls back to diagram-as-code). Any channel type may serve Image Writer; the agent picker suggests only configured channels whose models report `imageGen`, and shows none when no channel does.

## 5. Orchestration

Hub-and-spoke replaces v1's fixed Planner → Executor → Worker chain:
- Orchestrator calls `dispatch({role, task, files?, dependsOn?, expect})`; core runs that role's `RoleRunner` and returns a structured `result {status, summary, filesTouched, evidence}`.
- Typical flow: Investigator → Planner → Plan Validator (loop ≤ `maxReplans`) → optional user plan gate → Code Writer/Doc Writer tasks (parallel when files disjoint and deps met) → Tester/Reviewer → Orchestrator answer.
- Nested dispatch allowed one level (e.g. Code Writer asks Investigator): depth ≤ 2, at most `maxNestedDispatches` (default 3) per task, nested turns count against the parent's budget.
- Briefings: only the task, its files (bounded excerpts), dependent results, and a compact cross-milestone summary — telegraphic style (v1 `WorkerBriefing`).
- Every event (text, reasoning, tool request/outcome, compaction) is forwarded tagged with role + task id; UI renders collapsible per-role blocks and a milestone checklist.
- Usage and cost tracked per role and per agent, from the agent's `billing` (reported or priced).

### Context and memory
- Each dispatch starts a fresh context in deterministic prefix-cache order: `role system prompt → ticked skills → bounded AGENTS.md + project memory → task briefing`. Static prefix items come first so repeated dispatches of the same role hit provider prefix caches (Claude, OpenAI, NIM, Ollama). Nothing carries over between tasks except the structured `result` the Orchestrator receives. The Orchestrator alone keeps a conversation for the run and across follow-up messages in the same chat.
- Compaction (v1 behaviour) applies per task context when it nears the agent's `contextTokens`; the Orchestrator's context is compacted into the milestone checklist + results, never by dropping results.
- Skill text injected per role is bounded (default 8k tokens total, in tick order); overflow truncates the last skill with a visible marker and a settings warning.

### Parallel tasks and file leases
- `dispatch` validates that `dependsOn` is acyclic before scheduling, and may list `files`; core grants a write lease per path to the task. Tasks with disjoint leases and met `dependsOn` run in parallel up to each channel's `maxParallel`.
- An undeclared write acquires the lease on demand and waits if another task holds it; it never fails. Wait-for graph cycle detection runs on every undeclared lease wait: if task A and task B form an AB-BA cycle, the younger task's in-flight write is aborted and the task is re-queued after the older task finishes rather than stalling until timeout. Lease waits are shown in the UI (`waiting for <task>`); a wait longer than `leaseWaitSeconds` (default 300) is a fault handled by the stuck detector.
- Leases are released when the task finishes; reads are never blocked. Stale-preview checks still apply on execute.
- Before a run's first write to each file, core records a pre-image snapshot in `.stewart/scratch/<runId>/snapshots/` (alongside per-edit HostPort undo), enabling a one-click **Revert run changes** action on cancelled, failed or completed runs.

### Approvals and questions in a run
- One approval queue per chat, FIFO, shown as cards tagged with role + task. A task blocked on approval does not hold other tasks back; a `chat`/`always` grant drains matching queued requests at once.
- Nested `ask_user` goes to the Orchestrator first. It may answer from the request, plan or earlier results (answer recorded in the event log as `answered_by: orchestrator`); otherwise it forwards to the user verbatim. The optional plan gate and the cost-limit card always go to the user.
- Run cancel: stop scheduling, cancel in-flight streams, kill task process trees, release leases, mark tasks `cancelled`; finished work stays. `/resume` after an IDE restart marks in-flight tasks `failed: interrupted` and asks whether to re-dispatch them.

### Long runs and cost limit
A run is one user request and everything dispatched for it. Runs may go on almost indefinitely. Spend is the guard, not turn counts.

**Long runs**
- Role `turnBudget` accepts `unlimited`. With it, the continue question appears only when stuck detection fires, not on a turn count.
- Optional `maxRunHours` (0 = none) is a wall-clock guard. Fault recovery layers apply unchanged.
- The run ledger is persisted: cost per call, role, agent and task. The ledger is append-only with fsync per entry; a crash between call end and ledger write replays from the event log, so accrued cost is never lost. Accrued cost and the current cap survive an IDE restart and `/resume`.
- Every tool execution carries an idempotency key (task id + call index); `/resume` skips calls whose outcome is already recorded, so an interrupted run never re-executes a write that already landed.

**Config** (`settings.yaml`, per-project override)
```yaml
costLimit:
  perRunUsd: 5          # 0 = no limit
  onLimit: ask          # ask | stop
```

**When accrued cost reaches the cap**
- Core checks the ledger after every costing call. Once the cap is reached, no new call starts on a `reported`/`priced` agent.
- Calls already in flight finish rather than being cancelled. A cancel would waste what is already spent and leave tool outcomes uncertain. The overshoot is reported, bounded by the number of parallel costing calls.
- Tasks whose role agent costs move to `parked: cost_limit`. Role-agent bindings are not changed.
- Tasks on `free` and `unmetered` agents keep running as far as dependencies allow. A task that depends on a parked task waits.
- If the Orchestrator's own agent costs, core keeps scheduling the DAG already dispatched. New planning decisions wait for the user.

**Replacement suggestion** (runs when the cap is reached, before the summary is shown)
- Core lists enabled agents and filters out costing ones. For each parked role it keeps only candidates that meet the role's needs: tools, vision, `imageGen` and context size.
- One call to a free agent ranks the candidates per role. It uses the Orchestrator if free, otherwise the most capable free agent. Input: role purpose, skills, required capabilities and the candidate list. Output: `submit_replacements [{role, agent, reason}]`, validated against the candidate list. An invented id is dropped.
- With no free agent, the ranking is deterministic: capability match, then context size.
- With no candidates, the summary says so.

**Summary card**
- Shows: cap and accrued total; cost per role and per agent (with tokens); overshoot; parked tasks; tasks that finished on free agents after the cap.
- Options:
  - **Continue (+$5, new cap $10)**: the cap rises by `perRunUsd` again, and so on for each Continue.
  - **Use suggested replacements**: per role, this run only. A "save to roles" tick is off by default.
  - **Stop**: parked tasks end as `stopped: cost_limit`, and finished work is kept.
- No answer means the run stays parked at zero cost and free tasks continue. There is no timeout.
- With `onLimit: stop`, the card is shown with Continue still available, but the run finishes once the free work is done.
- Events `cost.limit_reached`, `cost.limit_raised` and `cost.replaced` go on the event bus. A future tracker comments on the ticket with each.

### Tool catalogue
Every tool has a JSON Schema for arguments and result, a permission category and a scope. Role tool lists reference these ids; "read-only" in §4 means the Read group.

| Group | Tool | Category | Notes |
|---|---|---|---|
| Read | `ReadFile`, `FindFiles`, `Search`, `GetProblems`, `GetDiff`, `ReadImage` | none | Bounded output; `GetProblems` via HostPort diagnostics; `GetDiff` via GitPort or `git` CLI |
| Write | `EditFile`, `WriteFile`, `ApplyPatch` | EDITS | Versioned edit + read-back; path restrictions per role (`docs only`, `assets`) enforced in core |
| Run | `RunTerminal` | COMMANDS | Streamed, cancellable, cwd-bound; read-only program allow-list for Investigator |
| Media | `GenerateImage` | OTHER | `/images/generations` or Mermaid/SVG fallback |
| Orchestration | `dispatch`, `ask_user`, `submit_plan`, `submit_verdict`, `submit_replacements` | none | Core-handled, never reach a channel as side effects; available only to the roles listed in §4 |

Path restrictions are glob lists on the role (`writePaths: ["docs/**", "*.md"]`); a write outside them is rejected before preview. Project-wide denies (`.stewart/` secrets, `.git/`, scratch excluded) apply to every role.

## 6. Kept from v1 (carried into core, with fixtures)
- **Execution contract** (`PLAN.md`): freeze model + native/shim per turn; execute only after successful completion; fail closed on incomplete/truncated/filtered streams; preserve call ids; approval bound to exact args/diff/cwd; stale-preview recheck; post-write read-back; never replay after execution starts.
- **Tool-call shim** as a per-model fallback (`SHIM_PARITY.md` formats, verbatim tests, GLM `<call>`, JSON repair, alias map). Native is the default everywhere it is supported.
- **Claude CLI transport** (`CLAUDE_FEASIBILITY.md`): exact isolation flags, fresh temp dir, stripped API-key env, `isolation_violation` check, stream-json images, login probe, proxy/CA env for the child.
- **Ollama**: `/api/tags` + `/api/show` capability probe (tools, vision, thinking), object `arguments`, synthesised ids, `num_ctx` per model, `native_tools_unsupported`.
- **OpenAI-compatible**: base URL join without doubling, `GET /models` union, string-only `content`, `reasoning_content`, `reasoning_effort` only for reasoning models.
- **Permissions** (`../ai_docs/PERMISSIONS.md`): categories EDITS/COMMANDS/OTHER; once/chat/always scopes; shell splitter with unparseable-construct list; fail closed; audit log; scratch auto-approve.
- **Fault recovery** (`../ai_docs/FAULT_RECOVERY.md`): classify TRUNCATED/INCOMPLETE_STREAM/TURN_LIMIT; layers retry → split (scratch) → re-plan; continue question with stuck detection; all limits.
- **Effort presets** (`PHASE2.md` M11): MEDIUM = v1 limits; provider fields sent only when the model supports them. New: `unlimited` turn budget per role (see §5 Long runs).
- **Usage/cost**: summed across turns, compaction and failed/cancelled calls; `cost n/a`, never `$0`, for unmetered agents. Changed: optional per-agent price (`billing: priced`) feeds the cost limit.
- **Images** (`../ai_docs/IMAGES.md`): limits, wire formats, vision gate, history stripping for non-vision models, hash-dedup storage. Now also routed to Image Reader, so non-vision roles get text.
- **Debug log** (`../ai_docs/DEBUG_LOGGING.md`): per-call lines, redaction of keys/bearer/base64, owner-only files, retention, rotation.
- **History**: per-project, atomic writes, retention, corrupt-file quarantine; add named sessions + `/resume`.
- **Chat UX**: right-aligned user bubbles, busy/active-role label, collapsible tool rows, prompt recall, slash commands, `@file/@selection/@problems`.
- **Project memory**: auto-inject bounded `AGENTS.md` + memory file.

## 7. Dropped / changed
- Fixed three-level orchestrator and `RolePrompts` → configurable roles + skill files.
- Per-provider classes and `multiModel` toggle, `plannerModel` overwrite, `(chat selection)` fallback → channel instances, agents, explicit role bindings (unset enabled role = configuration error, never silent fallback).
- Swing UI, `PersistentStateComponent` settings, Kotlin parsers → shared webview + YAML config + TS core.
- Separate `stewart-vscode` repo plan (`VISUAL_STUDIO.md` option a) → superseded by the shared core.
- AIJB rename migration, Nemotron, Qwen edit investigation, M1 feasibility spikes → done; only results kept.
- v1 settings import: one-shot importer from `stewart.xml` (channels, models, permissions); no ongoing compatibility.

## 8. Settings UI (webview, both hosts)
Modelled on the provider list in `docs/future/Screenshot…png`:
- **Channels**: list with type icon, status chip (Configured / Not configured / Disabled / Installed), power toggle, expand to edit; "Add channel" picks a type; duplicate allowed; "Test connection" + model discovery.
- **Agents**: table (name, channel, model, effort, billing/price); capability badges from probe; `unmetered` warning.
- **Roles**: tick box per role, agent dropdown filtered by required capability, skill tick list, tool list, budget, per-role Reset; header buttons Reset all / Assign default agent to all.
- **Skills**: list, open file in editor, new skill, reset shipped skill.
- **Permissions**, **Logging**, **Limits** (cost limit per run, `onLimit`, `maxRunHours`, turn budget defaults incl. `unlimited`).

## 9. Testing and gates

Unit/component:
- Core: `vitest` + `c8` ≥90% line, ≥80% branch; positive and negative test per change; conformance fixtures from v1 run unchanged.
- Webview: `vitest` + `@testing-library/preact` for components; Playwright against the webview bundle served standalone for chat/settings flows.
- Hosts: `@vscode/test-electron` smoke; JetBrains `BasePlatformTestCase` for HostPort + `verifyPlugin` on IDEA 2026.1 and PyCharm 2026.2.
- Protocol: schema tests for every JSON-RPC message and orchestration tool; version-mismatch and capability-degradation negative tests.

Contract suites (keep adapters and hosts honest):
- **Channel contract suite**: streaming, cancel, tool calls (native + shim), error/429 mapping, capability probe; run against every `ChannelAdapter` — a new channel type is mergeable only when it passes.
- **HostPort contract suite**: versioned edit + undo + read-back, secrets round-trip, process stream/cancel/tree-kill, diagnostics; run by both hosts against their real platform APIs, catching parity drift that TS-side fakes cannot.

Determinism:
- Injected `Clock`, `IdGen`, `Fetcher` make all core tests deterministic; `Fetcher` records and replays.
- **Golden transcripts**: recorded provider streams replayed through each adapter, snapshot-matched on the normalised event stream (beyond v1 parse conformance).

Orchestration (fake channels): leases serialise an undeclared write and release on finish; AB-BA undeclared lease cycle is detected immediately and re-queues the younger task; cyclic `dependsOn` is rejected; **Revert run changes** restores pre-run file snapshots across multiple tasks; stream delta coalescer batches chunks within 30ms and flushes on tool/lifecycle events; `maxParallel` queues the N+1th call; nested `ask_user` answered by the Orchestrator never reaches the UI; untrusted workspace ignores `.stewart/roles.yaml`; a role calling a tool outside its list or `writePaths` is rejected; circuit breaker opens after 5 failures and fails over to `fallbackAgent` (or parks when none/unapproved paid switch); stall timeout classifies a silent stream as TRUNCATED; `/resume` skips an idempotency key it already executed; copy-on-write skills auto-upgrade when `baseHash` matches and preserve user edits when modified.

Cost limit (fake channels with scripted costs):
- Positive: costing calls park at the cap while free tasks finish; Continue raises the cap to 2× and resumes; a run-scoped replacement leaves `roles.yaml` unchanged; the ledger survives a restart.
- Negative: no costing call starts after the cap; an in-flight call is not cancelled; an invented replacement id is rejected; `perRunUsd: 0` never parks; unmetered agents never trip the cap.

End-to-end, three levels:
- **Core e2e** (PR gate): scripted `FakeChannel` + `FakeHost` drive full runs headless — dispatch → leases → approvals → cost limit → resume.
- **VS Code host e2e** (PR gate): extension host + fixture-backed mock provider server; scripted chat verifies streaming, an edit, and undo end to end.
- **JetBrains host e2e** (nightly, not PR gate): headless IDE + real sidecar against the same mock server under xvfb; verifies sidecar lifecycle, JCEF wiring and host parity.

Live tests gated by env (`OLLAMA_LIVE`, `OAI_LIVE` per channel, `CLAUDE_LIVE`).

## 10. Milestones
| # | Scope | Done when |
|---|---|---|
| 1 | Monorepo, protocol, core skeleton, VS Code host, webview chat, OpenAI-compatible + Ollama text streaming, cancel | streams and cancels in VS Code; fixtures pass |
| 2 | JetBrains host: sidecar launch, JCEF webview, HostPort (secrets, proxy) | same chat works in IDEA and PyCharm; `verifyPlugin` passes |
| 3 | Config files, channel instances, agents (incl. `billing`/price), settings UI (Channels/Agents) | two OpenAI-compatible channels with different models usable side by side; cost recorded per call |
| 4 | Tool loop, tools, execution contract, permissions, shim | edit/command matrix passes on native and shim, both hosts |
| 5 | Claude CLI channel | isolation and multi-turn tool tests pass |
| 6 | Roles + skills: defaults, tick boxes, resets, enforcement | each role runs with its own agent/skills/tools; resets restore defaults |
| 7 | Orchestrator hub, plan validator loop, parallel tasks, plan gate, fault recovery, run ledger, cost limit, replacement suggestion, `unlimited` budgets | multi-role task completes across ≥3 channels; recovery and cost-limit tests pass |
| 8 | Images (reader/writer), memory, editor actions, diagnostics, history sessions, v1 import | feature tests pass; manual smoke on both hosts |
| 9 | Packaging: VSIX + per-OS JetBrains zips with bundled Node, signing, GitHub Releases publishing from CI | install smoke on Linux/Windows/macOS from the release assets |

Distribution: GitHub Releases carries the VSIX and one JetBrains zip per OS/arch. Users install from disk. Automatic IDE updates would need a custom plugin repository (`updatePlugins.xml`) per OS. That is optional and out of scope for v2.

## 11. Potential future features (hooks only in v2)

v2 builds only the seams below; the connectors themselves are later milestones.

### Lifecycle event bus (built in v2)
Core emits typed, persisted events for every run: `run.started`, `plan.created`, `plan.validated`, `plan.approved`, `milestone.started|done|failed`, `task.created|started|blocked|done|failed`, `review.done`, `run.finished`. Each carries stable ids (`runId`, `milestoneId`, `taskId`), title, role, files touched and outcome. Subscribers are plugins of core; a failing subscriber never fails a run.

### Task tracker connector (Jira first, provider-neutral)
- `TaskTrackerPort` in core is the only surface: `authenticate`, `createEpic`, `createIssue(parent, title, body, labels)`, `transition(issueKey, status)`, `comment`, `link`, `listStatuses(project)`. Core and roles never call a provider API directly. Default adapter: **Jira Cloud**, signing in through the browser with OAuth 2.0 (3LO) so the company SSO applies. The refresh token goes to the host secret store. An API-token login is the fallback. Jira Data Center, Azure DevOps, GitHub Issues and Linear are further adapters behind the same port. Before building, verify whether a Jira admin must register the OAuth app.
- Config: `trackers.yaml` — `id, type, baseUrl, project, auth (oauth | token), secretRef, issueType, statusMap`. `statusMap` maps core states (`todo | in_progress | in_review | done | failed | blocked`) to the project's workflow statuses.
- Flow: BRS/spec in → Planner + Validator produce milestones/build steps → user plan gate offers **"Create tickets in <project>"** → one epic per run (or per BRS), one issue per milestone/task → `taskId ↔ issueKey` stored in run state → event bus drives transitions and comments (summary, files, PR link, failure reason).
- Rules: ticket creation and bulk transitions are an approval category `TRACKER` (once / chat / always, as `../ai_docs/PERMISSIONS.md`); dry-run preview lists the tickets before creation; idempotent (re-running never duplicates — lookup by stored key or a `stewart-task-<id>` label); offline/failed calls queue and retry, never block development.
- Possible role: **Ticket Manager** (fast agent, skills `ticket-writing`, `brs-to-backlog`) for issue text; optional, defaults off.

### Git management through the IDE
- `GitPort` on HostPort, using the IDE's own git: VS Code `vscode.git` extension API; JetBrains Git4Idea (optional dependency). Falls back to the `git` CLI via `RunTerminal` rules when unavailable.
- Operations: status, diff (staged/unstaged/vs branch), branch create/switch, stage, commit, stash, pull/push, open PR (provider adapter later).
- Tools for roles: read-only `GitStatus`, `GetDiff` (Reviewer, Investigator); write `GitBranch`, `GitCommit` (Code Writer, General Worker); `GitPush`/PR for the user or the Orchestrator, the Orchestrator only with explicit user permission (`GIT` category, once / chat / always-in-project). History rewrite (force push, rebase of pushed commits) always asks.
- Branch per ticket: `stewart/<issueKey>-<slug>`, or `stewart/<runId>-<taskId>` when no tracker is configured. Tickets running in parallel each get their own `git worktree`, so branches never share a working tree. Without worktrees, tickets run one after another.
- Workflow hooks: commit per task with the issue key in the message, PR link posted back to the ticket, ticket moved to `in_review` on PR and `done` on merge (when the provider reports it).
- UI: changed-files panel per run, diff open in the native IDE viewer, commit message proposal from the run summary.

### v2 obligations so these can be added later
- Event bus with persisted ids (above); run state stores external refs (`externalRefs: {tracker?, branch?, pr?}`).
- Approval categories are an open set (`TRACKER`, `GIT` added without schema change).
- Plan/task schemas carry `acceptanceCriteria` and `sourceRef` (BRS section) so tickets can be generated without re-planning.
- Settings UI has an "Integrations" section placeholder; config loader accepts unknown files.

## 12. Open questions
1. ACP channel type timing (Claude Code, Codex, Gemini, Kiro agents).
2. Jira OAuth app registration: does the Atlassian site admin need to register it, and which workflow statuses does the target project use (fills `statusMap` defaults)? Status maps are different for every project. Will need to get a list per project from the API and populate it per project in the .stewart config.
3. OpenAI-compatible `billing: reported`: which cost fields to recognise (e.g. OpenRouter `usage.cost`). AI Factory returns none and is internal/free: its default is `billing: free`, set in the channel preset. Unknown. Will have to identify costs from the provider's API response.

## 13. Decided
- JetBrains remote development (Gateway) is out of scope for v2; local IDEs only. The tool window shows a notice in a remote session.
- Minimum host versions: VS Code `^1.145.0` (current stable at 2026-11-04), JetBrains `since-build 261` (2026.1+), Node 22 LTS.
- AI Factory channel preset: `billing: free`, no `unmetered` warning.
- Test strategy: three e2e levels — core e2e and VS Code host e2e are PR gates; JetBrains host e2e runs nightly under xvfb. New channel types merge only with a passing channel contract suite.
- Runtime resilience & efficiency: AB-BA lease deadlock detection, one-click run revert via `.stewart/scratch/<runId>/snapshots/`, 30ms stream delta coalescing, atomic multi-window config writes, copy-on-write shipped skills (`baseHash`), role `fallbackAgent`, prefix-cache context ordering, and external `ToolProvider` seam.

# Stewart — Feature List

Cross-IDE AI assistant: one shared TypeScript core, a VS Code host and a JetBrains host, with configurable channels, agents, roles and skills.

Sources: `docs/ARCHITECTURE_NOW.md` (what is built), the v2 docs (`docs/archived_v2/*`, `BUDGETS_AND_SETUP_INFO.md`, `FAULT_RECOVERY.md`, `PERMISSIONS.md`, `IMAGES.md`, `SETUP.md`, `DEBUG_LOGGING.md`, `RELEASING.md`, `PROGRESS.md`, `2026-11-07-code-health.md`).

Status key: **Built** = in the code per `ARCHITECTURE_NOW.md`/`PROGRESS.md`. **Partial** = built with stated gaps. **Planned** = specified but not built.

---

## 1. Platform and hosts

| Feature | Detail | Status |
|---|---|---|
| Shared TS core | All logic in `packages/core`, no host imports. Only a small `HostPort` interface is host-specific. | Built |
| VS Code host | Core runs in-process in the extension. `HostPort` is implemented with the vscode API (versioned edits, secrets, diagnostics, processes). Packaged as `stewart.vsix`. | Built |
| JetBrains host | Thin Kotlin plugin (IDEA, PyCharm and other 2026.1+ IDEs, `since-build 261`). It launches a bundled Node sidecar and shows the UI in JCEF. | Built |
| Node sidecar | Stdio NDJSON JSON-RPC server. Handles the handshake, project attach, event forwarding and reverse-RPC `host.*` calls onto `HostPort`. | Built |
| Sidecar supervision | Restart with exponential backoff. A crash loop (5 starts in 60 s) degrades to an error state. In-flight runs are marked failed and are resumable. Process trees are killed on close. | Built |
| Bundled Node 22 | One JetBrains zip per OS/arch (linux-x64/arm64, macos-x64/arm64, windows-x64) with a SHA-256-verified Node. A base zip uses system Node. | Built |
| JSON-RPC protocol | Versioned protocol with capability negotiation. A minor version skew degrades a feature with a notice. A major skew fails with an actionable error. | Built |
| One webview for both hosts | Preact chat, settings and setup wizard in one bundle. Strict CSP (nonce scripts, no remote origins, no `eval`). Messages validated against the protocol. | Built |
| `HostPort` contract | Secrets, versioned read/edit with one undo step and read-back, diff preview, process run/stream/cancel/tree-kill, proxy and CA certs, diagnostics and symbols, editor selection, workspace roots and state dir. | Built |
| Injected seams | `Clock`, `IdGen`, `Fetcher` and `HostPort` are injected, so tests are deterministic and provider streams can be recorded and replayed. | Built |
| Unsupported setups | JetBrains remote development (Gateway) shows a notice. JCEF is required, with an actionable fallback message. | Built |
| Visual Studio target | Feasibility only. VS Code was chosen as the second host. | Planned |

---

## 2. Channels, agents and models

### 2.1 Channels
- **Channel instances, not hard-coded providers.** Any type can be added several times, for example two OpenAI-compatible endpoints.
- **Channel types:**
  - OpenAI-compatible (OpenAI, OpenRouter, LM Studio, AI Factory, NVIDIA NIM and others).
  - Ollama.
  - Claude Code CLI (`claude-cli`).
  - A later ACP channel type (Claude Code, Codex, Gemini, Kiro agents) is **Planned**.
- **`ChannelAdapter` interface.** A new channel type needs no core changes. Every adapter must pass the shared channel contract suite.
- **Model discovery.** `GET /models` is unioned with `extraModels` (OpenAI-compatible). `/api/tags` is used for Ollama. Claude CLI uses a static table.
- **Managed channels.**
  - `maxParallel`: Ollama defaults to 1, others to 4. Calls beyond the limit queue.
  - Per-channel back-off on 429/`Retry-After`.
  - Request timeout plus a stream stall timeout (default 60 s with no chunk). A stall is classed as truncated and goes to fault recovery.
  - Circuit breaker: 5 consecutive failures mark the channel unhealthy, park its tasks and show a badge. One success or Test connection closes it.
- **Secrets never in YAML.** `channels.yaml` holds only `secretRef`. Keys go to the IDE secret store (`SecretStorage` / `PasswordSafe`). The webview never gets them back.
- **Proxy and CA support.** Applies to HTTP calls and to the Claude CLI child environment.

### 2.2 Provider specifics
- **Ollama:**
  - `/api/show` capability probe (tools, vision, thinking, `context_length`).
  - Object-form `arguments` and synthesised tool-call ids.
  - Per-model `num_ctx`, with auto sizing and truncation detection.
  - `native_tools_unsupported` handling.
- **OpenAI-compatible:**
  - Base-URL join without doubling.
  - String-only `content`.
  - `reasoning_content` handling.
  - `reasoning_effort` only for reasoning models.
  - Live price list (`priceList`, OpenRouter).
- **Claude CLI:**
  - Exact isolation argv and a fresh temp working dir.
  - `ANTHROPIC_*` environment stripped.
  - `isolation_violation` check.
  - stream-json image input.
  - Login probe (`auth status`).
  - `total_cost_usd` metering.
  - Error classification: auth, model unavailable, rate limited.

### 2.3 Capabilities and probing
- **Capabilities per model:** `tools` (native | shim | none), `vision`, `reasoning`, `imageGen`, `contextTokens`, `numCtx`. Unknown tools means shim. Unknown vision means no images.
- **Probe on demand.** "Test connection" and the wizard run `channel.probe`. Results are cached in memory with a Re-probe button.
- **Precedence of model facts:** user `modelCaps` > probe cache > bench `perf` > price catalog / live price list. The agent `price` wins for cost. `modelProfile.ts` is the single merge.
- **Gap:** the probe cache is not persisted across restarts. Bench `perf` is persisted via `modelCaps`.

### 2.4 Agents
- An agent is channel + model + parameters (`effort`, `temperature`).
- **Billing modes:** `free`, `reported`, `priced` (per-agent price per MTok), `unmetered`. Defaults follow the channel type. `unmetered` agents get a warning badge because the cost limit cannot see their spend.
- **`costs` flag** (derived by default). A `$ costs` badge shows on the agent and on every role that uses it.
- **Per-agent budget overrides:** `agent.budget.{turnFactor, timeoutFactor}`.
- **Shipped presets**, for example AI Factory with `billing: free`.

### 2.5 Price and limits catalog
- Bundled, versioned `catalog.data.json` with `lookupModelInfo` (price, context, rpm/tpm, family, tier).
- `blendedCost` and `costTier` (free | low | mid | high).
- Live provider pricing preferred over the catalog.
- The wizard prefills `billing` and `price`. An existing `agent.price` always wins.

---

## 3. Roles, skills and prompts

### 3.1 Roles
- **12 shipped default roles**, all disabled and unbound until set up: Orchestrator, Planner, Plan Validator, Investigator, Architect, General Worker, Code Writer, Code Reviewer, Tester, Document Writer, Image Reader, Image Writer.
- **Extra shipped role:** `code-health-reviewer` (disabled, read-only). An optional user-defined `compactor` role is used by context summarization.
- **Role fields:** `id`, `enabled`, `prompt`, `agent`, `fallbackAgent`, `skills`, `tools`, `writePaths`, `turnBudget` (a number or `unlimited`).
- **Enforcement in core, not just in the prompt:**
  - A role cannot call a tool outside its list.
  - `WriteFile`, `EditFile` and `ApplyPatch` are wrapped so a path outside `writePaths` is rejected before the preview.
  - Project-wide denies (`.git/`, `.stewart/` except `scratch/`) apply to every role.
- **Capability gating:** Image Reader needs a `vision` agent. Image Writer needs an `imageGen` agent.
- **Validation:** an enabled role with no agent, an unknown agent, or a missing capability is a configuration error. An unset enabled role never silently falls back.
- **Orchestrator required** once any other role is enabled.
- **Failover:** `fallbackAgent` takes over when the primary channel is unhealthy. A free-to-paid switch asks the user first.
- **Resets:** per-role Reset to default, Reset all roles, Assign default agent to all.
- **Read-only Investigator terminal:** `RunTerminal` is limited to a read-only program allow-list.

### 3.2 Skills
- **Format:** `skills/<id>/SKILL.md` with frontmatter (`id`, `description`, `defaultRoles`, `version`, `baseHash`).
- **Shipped defaults with copy-on-write:**
  - Unedited copies track the shipped body and auto-upgrade.
  - Edited copies keep the user text and show an "update available" badge.
  - Reset skill restores the shipped text.
- **Prompt composition:** role prompt, then ticked skills, then bounded `AGENTS.md` and `MEMORY.md`, then the briefing. The order is deterministic so provider prefix caches hit.
- **Token bound:** `skillBudgetTokens` truncates the last skill with a visible marker.
- **`execution-contract`:** forced on any role holding side-effect tools and cannot be unticked.
- **Settings UI:** skill list, Open file in editor, New skill (duplicate-id guard), Edit and Reset.

### 3.3 Code-health skill and reviewer (`docs/2026-11-07-code-health.md`)
- Read-only role with tools `ReadFile`, `FindFiles`, `Search`, `GetProblems`, `GetDiff`.
- **Inputs:** files, a folder (capped at 20 files, samples reported), a file with line range, a function, or an inline block.
- **Modes:** *score only* or *score + issues* (default).
- **Rubric (a Stewart heuristic approximating CodeScene Code Health, not the real metric):**
  - Start at 10.0 and deduct per finding: high −2.0, med −1.0, low −0.3. Cap −4.0 per smell category.
  - Bands: Green ≥ 9.5, Yellow 7.0–9.4, Red < 7.0.
  - Smells: complexity, large units, deep nesting, low cohesion, duplication, closure/state tangle, dead code, suppressions, coupling, coverage gap.
  - Folder score is the LOC-weighted mean. The worst file and the Red-file count are also reported.
- **Output contract:** a scope line, then score lines, then `path:line | smell | severity | refactor` findings. It states what was not checked.
- Unstable hotspots are "not checked" (needs git history). A manual smoke test (T4) has not been run.

---

## 4. Run paths and orchestration

### 4.1 Three run paths (one pipeline)
- **Direct:** a chat message runs as a single-task run (`driveDirect` → `runRoleTask`) on the chat role or a synthetic `chat` role. It is metered, cost-capped, leased, journaled and resumable. A lone `direct` task shows no task rows in the UI.
- **Orchestrated:** `OrchestratedRun` with a hub-and-spoke Orchestrator.
- **Resume:** `/resume` re-enters via `runTaskRecoverable`. A direct resume replays only the original request, on the journaled agent, and skips executed calls.
- **Mode is automatic:** Orchestrator enabled and bound means orchestrated; otherwise direct. The chat header shows the mode. `/direct` forces one message to the selected agent.

### 4.2 Orchestrator hub
- **Core-handled verbs** in the same `ToolRegistry`: `dispatch`, `ask_user`, `submit_plan`, `submit_verdict`, `submit_replacements`, `submit_recovery`.
- **Typical flow:** Investigator, then Planner, then Plan Validator (loop up to `maxReplans`), then an optional plan gate, then Code Writer/Document Writer tasks (parallel when files are disjoint), then Tester/Reviewer, then the answer.
- **Nested dispatch:** depth ≤ 2, at most `maxNestedDispatches` per task, counted against the parent's budget.
- **Fresh context per task.** Nothing carries over except the structured result. The Orchestrator alone keeps the run conversation.
- **Hard plan gate** blocks write roles before the plan is approved.
- **`ask_user` routing:** a nested question goes to the Orchestrator first, which may answer it (recorded as `answeredBy: orchestrator`) or forward it to the user. The plan gate and cost-limit card always go to the user.
- **Orchestrator tools are restricted** to dispatch/ask/submit verbs. Its tool output is capped.
- **Format-nudge retry:** if the Orchestrator replies with an unparsed tool-call tag, it retries once with a format nudge.

### 4.3 Task graph, leases and parallelism
- `TaskGraph` rejects duplicate ids and unknown or cyclic `dependsOn`. It computes ready tasks and failure blocking, and is persisted for resume.
- **Per-path write leases (`LeaseManager`):**
  - Reads are never blocked.
  - Declared files are leased up front. Undeclared writes acquire on demand and wait.
  - AB-BA deadlock detection requeues the younger task.
  - Lease waits are shown in the UI.
- Tasks with met dependencies and disjoint leases run in parallel up to each channel's `maxParallel`.
- **Parallel tool batches** inside `ToolLoop` for tools flagged `parallel`.

### 4.4 Run state and recovery
- **Idempotency log:** keys `runId:taskId:callSeq`. `/resume` skips calls already executed, so writes never replay.
- **Run journal** (`run.json`) with the task graph and agent ids. Resume fails closed when the graph is absent or unreadable.
- **Pre-image snapshots** before each run's first write to a file. One-click **Revert run changes** restores modified files and removes created ones, across tasks.
- **Cancel:** stops scheduling, cancels streams, kills process trees, releases leases. Finished work is kept.
- **Briefings:** only the task, bounded file excerpts, dependency results and a compact summary.

---

## 5. Tool loop and tools

### 5.1 `ToolLoop` (stream → parse → execute)
- **Execution contract:**
  - The model and the native-or-shim mode are frozen per turn.
  - Execute only after a completed stream, and fail closed on truncated or filtered streams.
  - Tool-call ids are preserved.
  - Approval is bound to the exact args, diff and cwd.
  - Stale-preview and changed-since-approval rechecks.
  - Post-write read-back.
  - Never replay once execution has started.
- Turn limits, duplicate-id detection, 60 s tool timeout (scaled by profile), uncertain outcomes on cancel or timeout, and transcript repair (`closeOpenToolCalls`).
- **Per-call model timeout** (`modelCallTimeoutMs`) via `AbortSignal.timeout`, plus the channel stall timeout.
- **Truncation retry** (`maxTruncationRetries`).
- Built only by `createAgentSession`, the single place that wires profile, limits, events and ledger metering.

### 5.2 Tool-call shim (per-model fallback)
- **Accepted text formats:**
  - `<tool_call>` JSON.
  - Attribute form `<tool_call name=… arguments='…'>`.
  - `<call>` (GLM).
  - `<function=NAME>`.
  - GLM `<arg_key>`.
  - Gemma forms.
  - Fenced JSON and bare JSON.
- JSON repair, an exec-alias map (to `RunTerminal`), native-call repair, and TC-* failure codes.
- Strips Gemma `<channel|>` / `<|channel>thought` markers.
- **Streaming filter (`streamFilter.ts`, shim mode):** hides tool-call tag blocks from the live text shown in the panel, even when split across chunks.
  - An unfinished block is held back. It is shown at turn end only if nothing parsed.
  - Gap: calls written as fenced JSON or bare JSON still show in the live text.
- Verbatim conformance fixtures from v1 are replayed in `packages/conformance`.

### 5.3 Built-in tools
| Group | Tools | Notes |
|---|---|---|
| Read | `ReadFile`, `FindFiles`, `Search`, `GetProblems`, `GetDiff`, `ReadImage` | Bounded output. `GetProblems` uses IDE diagnostics. |
| Write | `EditFile`, `WriteFile`, `ApplyPatch` | Versioned edit, native undo, read-back, per-role `writePaths`. |
| Run | `RunTerminal` | Streamed, cancellable, cwd-bound, program allow-list for read-only roles. |
| Media | `GenerateImage` | `/images/generations`, or a Mermaid/SVG fallback. |
| Orchestration | `dispatch`, `ask_user`, `submit_*` | Core-handled. |
- **External `ToolProvider` seam** for future MCP adapters. Tools register under `MCP:<server>` approval categories.
- **Tool output ingest cap:** about 10% of the context cap (max 20k chars, min 2k), keeping a 70% head and a 30% tail.

### 5.4 Context compaction (`tools/compaction.ts`)
Stages run in order. Thresholds come from the budget profile: quick 40/60%, normal 60/80%, deep 75/90% of the cap.
1. **Prune stale results** (`compaction.prune`, default off): superseded and re-read tool results are stubbed.
2. **Summarize the middle** (`compaction.summarize`, default off): an enabled `compactor` role writes a structured note. The last user message is pinned and the last 6 messages are kept, with tool pairs intact. Cost is metered under `compactor`.
3. **Emergency clip**, else a `context_limit` failure.
- The context cap derives from the model window: 3 chars per token, clamped to 8k–400k chars.
- A `compaction` event reports before/after tokens and what was pruned or summarized. The webview shows it as an activity line.
- Gap: not wired for recovery and bench loops.

---

## 6. Cost, budgets and limits

### 6.1 Cost tracking and limit
- **Append-only fsync'd ledger** (`ledger.jsonl`). Cost per call, role, agent, task and tokens. It survives restarts and `/resume`.
- **`cost n/a`** (never `$0`) for unmetered agents. Usage is summed across turns, compaction and failed or cancelled calls.
- **Cost limit:** `costLimit.perRunUsd` and `onLimit: ask|stop`.
  - No new costing call starts after the cap. In-flight calls finish and the overshoot is reported.
  - Costing tasks park as `cost_limit`. Free and unmetered tasks continue.
- **Summary card:** cap, accrued total, cost per role/agent, overshoot, parked tasks. Options: Continue (+cap), Use suggested replacements, Stop.
- **Replacement suggestions:** capability-filtered free candidates, ranked by a free agent or deterministically (capability, then context). Invented ids are dropped. Applies to this run only unless "save to roles" is ticked.
- **Events:** `cost.limit_reached`, `cost.limit_raised`, `cost.replaced`, `cost.summary`.

### 6.2 Budget profiles (quick / normal / deep)
- **`settings.budgets`:** `turnMultiplier`, `timeoutMultiplier`, `allowSplit`, `maxRunMinutes` per profile (deep is unlimited).
- **`resolveLimits`** (the only source of `LoopLimits`): role budget × profile × model factors, clamped, with `maxWorkerTurnsCeiling` (default 60).
- **Model factors:** speed (reference 40 tok/s), cost, and tool reliability. `unlimited` budgets are preserved.
- **Run caps:** `maxRunHours` and `maxRunMinutes`. One abort timer per run ends it `interrupted` and resumable.
- **Task-size classifier** (`classifyTask`): deterministic. Uses prompt length, keywords, `@mentions`, attachments, orchestration and workspace size. Overrides: `/quick` and `/deep` prefixes or the composer selector. A profile badge shows in the chat header and Active card.
- **Escalation** (quick → normal → deep): **Planned** (M6), now unblocked by the recovery port.

### 6.3 Fault recovery (`docs/FAULT_RECOVERY.md`)
- **Fault kinds:** `truncated`, `incomplete_stream`, `turn_limit`. `context_limit` is a separate failure.
- **Layer 0:** retry `incomplete_stream` once at any level. Size faults retry once with a size hint for read-only roles and the orchestrator.
- **Layer 1:** split a faulted write task into serial sub-tasks via `submit_recovery` on the orchestrator's agent. Sub-tasks write to scratch and code joins them into `final_file`. Nests to `maxRecoveryDepth`, and is skipped in quick.
- **Layer 2:** re-plan via the validator's `revise` verdict. v1's `FaultNote` is not ported.
- **Continue question:** shown on a turn limit, with done-so-far and a "looks stuck" hint (same call 3+ times, or 5 turns without a successful write).
  - Options: Continue (+N turns), Split, Stop, or free text.
  - Timeout and cancel emit `question.withdrawn`.
  - Plain chat offers Continue and Stop only.
- **Scratch dir** `.stewart/scratch/<runId>/task-<id>/`: auto-approved writes, deleted on success and kept on failure. Retention pruning is not ported.
- **Settings:** `askOnTurnLimit`, `continueQuestionTimeoutMinutes`, `maxRecoveryDepth`, `maxRecoveriesPerRun`, `maxSubTasks`, `maxContinuations`, `maxContinueQuestionsPerRun` and others.

---

## 7. Safety, permissions and governance

### 7.1 Approvals (`docs/PERMISSIONS.md`)
- **Categories:** `EDITS`, `COMMANDS`, `OTHER`. The set is open (for example `MCP:<server>`, and future `TRACKER` or `GIT`).
- **Scopes:** just once, for this chat (memory only), always in this project.
- **FIFO approval queue** with cards tagged by role and task. A chat or always grant drains matching queued requests. A blocked task does not hold others back.
- **Shell command splitting** on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes. Grants are per program. A POSIX splitter is built. Windows `cmd` handling is described.
- **Always prompts (unparseable):** command or process substitution, redirections, heredocs, dangerous env assignments (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS` and others), re-entrant shells and launchers (`sh -c`, `python -c`, `xargs`, `sudo`, `env`, `find -exec` and others), grouping, and unbalanced quotes.
- **Fail closed:** any error in the check prompts. A null or unknown preview is never auto-approved.
- **Revoke paths:** bypass popup, settings page, and `/permissions` (list, clear, revoke, reset).
- **Audit:** auto-approved calls go to the debug log.
- **Scratch auto-approval** for writes strictly inside the run's registered scratch dir.
- **Grant granularity gap:** a program grant covers every invocation, so `git` also allows `git push --force`. There are no argument-scoped grants.

### 7.2 Trust and config safety
- **Trusted workspaces only** read project `.stewart/` files, which carry `roles.yaml` and `skills/` only. Channels, agents and secrets stay user-level, so a repo cannot point an agent at a foreign endpoint.
- **`SelfWriteGuard`:** content-hash suppression so Stewart's own config writes do not loop the file watchers.
- **Atomic writes** (temp and rename) so concurrent IDE windows cannot corrupt YAML.
- Invalid YAML keeps the last good config and shows the error in Settings.

### 7.3 Debug logging (`docs/DEBUG_LOGGING.md`)
- `settings.log.level`: `off` (default), `calls` (provider requests, responses, errors, Claude CLI stdio) or `full` (adds every bus event).
- One line per record in UTC-daily files (`yyyy-MM-dd.log`). Files are mode 0600 and the folder 0700. Writes are buffered.
- **Redaction:** `Authorization` values, `Bearer` tokens and every stored channel secret become `[REDACTED]`. Image payloads become placeholders.
- **Retention:** `retainDays` (default 7, 0 keeps everything). Only files the sink wrote are pruned.
- Gaps: no size-based rotation, no settings UI for `log`, and no per-project level.

---

## 8. Configuration

- **Shared user dir** `~/.config/stewart` (`$STEWART_CONFIG_DIR` > `$XDG_CONFIG_HOME` > `%APPDATA%\stewart`): `channels.yaml`, `agents.yaml`, `roles.yaml`, `settings.yaml`, `skills/`. One dir for every IDE and project.
- **Precedence:** shipped defaults < user < project, merged field by field, with list items merged by `id`.
- **Zod schema** validation. Files are watched and edits apply on the next run.
- **Legacy copy:** missing files are copied once from the older per-project JetBrains and VS Code user-config dirs. Nothing is overwritten.
- **State dir** (via `HostPort`): ledger, run journals, scratch, history.
- **One-shot v1 import** of channels, models and permissions from `stewart.xml`, with draft warnings and a preview before Apply.
- **Gap:** each file carries `version: N` with per-version migrations per the plan. Whether this is built is not stated in `ARCHITECTURE_NOW.md`.

---

## 9. Setup wizard and model assignment (`docs/SETUP.md`)

- **Steps:** Welcome → Channels → Discover → Evaluator → Review → Done. It opens automatically when no channels or agents exist, and is re-runnable from Settings → Run setup.
- **Channel presets:** Ollama, OpenAI, OpenRouter, LM Studio, other OpenAI-compatible, Claude CLI. Each channel is auto-tested and errors map to fixes (for example "Is Ollama running?" or "Check the key").
- **Discover:** `channel.probe` per model for tools, vision, reasoning, imageGen and context.
- **Optional benchmark** (opt-in, 30 s cap per model): TTFT, tokens per second, tool round-trip reliability (3 trials), JSON validity and edit ability. It is run through `ToolLoop`, so shim reliability is measured too. Results are stored in `modelCaps[model].perf`.
- **Two evaluators:**
  - **Rules** (default, no model call): `scoreAssignments` applies hard filters (tools, vision, imageGen) and soft weights (size from name, reasoning, coder, native tools, context, local/free, measured speed, cost, reliability, edit). It spreads load across models.
  - **AI:** the chosen model refines the proposal. Picks that fail hard requirements are dropped, and it falls back to rules with a message.
- **Role requirement profiles** (latency, typical turns, `needsEdit`, `minToolReliability`, cost sensitivity, parallelism).
- **Setup context:** workspace scan (20k files / 2 s caps, `.gitignore` respected), hardware (RAM, NVIDIA GPU), and priority sliders (speed, cost, quality) plus typical work. These are persisted for the next run.
- **Review table:** editable role → `channel:model` with score, reason, warnings and billing badge. Unfillable roles are disabled with a reason. Apply writes `agents.yaml` and `roles.yaml`.
- **Gaps:** resume after IDE restart, YAML undo backup, Claude CLI auto-detect, and a quality-vs-free toggle.

---

## 10. Chat and UI (webview)

- **Chat:**
  - Streaming text and reasoning.
  - Right-aligned user bubbles.
  - Busy and active-role label.
  - Collapsible tool rows.
  - Up/Down prompt recall.
  - Mode and profile badges.
  - Activity lines for compaction.
- **Run panels:** Active tasks, Tasks and plan rows, and a Cost card (hidden for free direct runs). Also Revert run changes, approval cards, question cards (cleared on `question.withdrawn`) and the cost-limit summary card.
- **Slash commands:** `/direct`, `/quick`, `/deep`, `/resume`, `/permissions`, `/image <path>`, and `New chat`. The `/permissions` and `/image` commands are documented from v1 and their v2 wiring is not confirmed.
- **Mentions and context:** `@file`, `@selection`, `@problems`. Bounded `AGENTS.md` and `MEMORY.md` are injected into role context.
- **Images:**
  - Attach via picker, paste, drop or `/image`.
  - Limits: 5 per message, 5 MB each, longest edge 1568 px, formats png/jpg/jpeg/gif/webp.
  - A vision gate with history stripping for non-vision models (`[image: name]`).
  - Hash-deduplicated storage, and placeholders in logs.
  - Image Reader role gives text descriptions to non-vision roles. Image Writer generates images or diagrams.
- **History:** per-project sessions (list, load, delete), atomic writes, retention, and corrupt-file quarantine.
- **Settings tabs:**
  - Channels: status chip, power toggle, add, duplicate, test, probe.
  - Agents: table, capability and `unmetered` badges, price inputs.
  - Roles: tick box, agent dropdown filtered by capability, skills, tools, `writePaths`, budget, resets.
  - Skills.
  - Permissions, Logging, Limits.
  - An Integrations placeholder.
- **Editor integration:** JetBrains "Add selection to chat" action (path:lines inserted into the composer), `host.editor.selection`, and `insertText`.
- **Diagnostics tools:** `GetProblems` through IDE diagnostics.
- **High-frequency event coalescing:** planned as 30 ms frames. Whether it is wired is not stated in `ARCHITECTURE_NOW.md`.

---

## 11. Build, test, release

- **Monorepo:** pnpm, with `packages/{core,protocol,sidecar,webview,conformance}` and `hosts/{vscode,jetbrains}`. The JetBrains module is Kotlin with Gradle, IntelliJ Platform Plugin and Kover.
- **Tests:** vitest for core, webview, sidecar and protocol. Conformance replays golden v1 fixtures through the parsers. Kotlin tests have a Kover gate (≥90% line, ≥80% branch). JCEF e2e runs under xvfb in nightly CI. Every change ships positive and negative tests.
- **Channel contract suite** for new adapters, and a `HostPort` contract suite for both hosts.
- **CI:** `ci.yml` runs build, typecheck, test, VSIX, and Gradle `test koverVerify buildPlugin`. `e2e.yml` runs nightly. Dependabot keeps workflow actions current.
- **Releases:** a `vX.Y.Z` tag builds the VSIX and all JetBrains zips and creates a GitHub Release. It is the single version source, with prerelease suffixes allowed.
- **Signing and publishing** (secrets-gated): `VSCE_PAT` for the marketplace, plus `CERTIFICATE_CHAIN` and `PRIVATE_KEY` for JetBrains signing.
- **JetBrains update feed** `updatePlugins.xml` on GitHub Pages.
- **Local one-command install:** `scripts/build-install.sh`.
- **Compatibility:** VS Code `^1.145.0`, JetBrains 2026.1+ (`verifyPlugin` on IC 2026.1 and PyCharm 2026.2), Node 22 LTS.

---

## 12. Planned and not yet built

- **Budget escalation** (quick → normal → deep, auto and via the continue question). Unblocked by the recovery port.
- **Task-tracker connector** (Jira first, provider-neutral `TaskTrackerPort`, `trackers.yaml`, `TRACKER` approval category, Ticket Manager role). The seams exist: lifecycle event bus, persisted ids, open approval categories, Integrations tab placeholder.
- **Git management through the IDE** (`GitPort`, status/branch/commit/PR tools, `GIT` approval category, branch and worktree per ticket).
- **ACP channel type** (CLI agents).
- **MCP provider adapter.** Only the `ToolProvider` seam exists.
- **Terminal mirroring** of `RunTerminal` into the IDE terminal.
- **Phase 2 items from the v1 plan.** Re-check each against the v2 code before relying on it:
  - Effort presets (`effort`) forwarded to providers.
  - File outline and usage tools.
  - Multi-hunk edit preview.
  - Quick-fix intentions.
- **Known gaps:**
  - No layer-2 `FaultNote`.
  - Probe cache is not persisted.
  - Scratch retention is not pruned.
  - Debug log has no rotation.
  - Fenced and bare JSON calls are visible in live text.
  - Manual smoke checks pending (code-health T4, image manual checklist).

# Stewart — New Design (2026-11-12)

Status: **accepted; steps 0–6 built as v3.0.0; §8 gaps, the 2026-11-13 audit findings (§8.4) and the remaining deviations (§8.5) are fixed; evals re-run 2026-11-13 at 15/15 on three configs (EVALS.md). Open: no local model qualifies as an agent, ACP not built, design revision §9 built 2026-11-13 (code gates pass; evals not re-run)**. Replaces the run/orchestration design in `docs/ai_docs/ARCHITECTURE_NOW.md`. Decisions taken with the user on 2026-11-12: all four kinds of work matter (code changes, reviews/reports, questions, long builds); cheap model first with automatic escalation; Claude Code CLI runs as a full agent; clean rewrite of the core.

## 1. What the logs show

Source: `~/.cache/JetBrains/IntelliJIdea2026.3/log/stewart/debug_logs/2026-11-06…12.log` (`log.level: full`, one IDE, 7 days).

| Measure | Value |
|---|---|
| Finished runs | 39: 8 `done`, 29 `no_dispatch`, 1 `failed`, 1 `cancelled` |
| Tool calls | 253, of which 54 failed (21%) |
| File writes | 22 attempted (`EditFile` 21, `WriteFile` 1), **0 succeeded**; that run still ended `done` |
| `dispatch` | 14 ok, 14 `uncertain` (timed out), 4 `invalid` |
| Argument rejections | 14 (`path: null`, array sent as a JSON string, a tool named `tool_call`) |
| Native tool calling | 5 of 404 model requests on 10–12 Nov (probes included); the rest use the text shim |
| Claude CLI | one process per turn, `--tools ""`, temp cwd, killed after the turn (56 `exit code 143`) |
| Local context | `num_ctx` 4k–14k tokens; a reviewer's system prompt is ~16k chars before any file is read; 18 provider-side prompt truncations |

Code size: 26 modules, ~21.6k source lines, ~21k test lines. The tests pass and the gates are green, yet no run in the week changed a file.

## 2. Why the design fails

1. **Routing is mandatory.** Every request goes to an Orchestrator that may not do work. A direct answer ("list the files in docs/") is a correct result reported as the error `no_dispatch`. 29 of 39 runs ended this way.
2. **Each hop loses context.** A worker starts from a briefing written by a routing model and returns a text summary. Follow-ups ("yes", "score the 6 files we have") reach an Orchestrator that kept no tool results.
3. **Every model is reduced to the weakest interface.** All channels are driven as text completion plus a parsed tool-call format. Claude Code, a complete agent, is used as a text pipe with its tools off and no session. Small local models must follow a text protocol they were not trained on.
4. **Hard work goes to the weakest models.** File editing is assigned to a 7b model with a 4k–14k window, and the prompt (role + four skills + `AGENTS.md` + tool block) fills half of it.
5. **"Done" means "the model stopped".** Nothing checks that the task's goal holds. Twenty-one identical failing edits were followed by `done`.
6. **Machinery compensates for the above.** Recovery layers, task splitting, leases with deadlock detection, idempotency replay, plan verbs and replacement ranking each add failure modes of their own (lost reports, timeouts, stale journals), and none of them makes a weak model succeed.
7. **Quality is measured on the code, not on outcomes.** Coverage and function-size gates were enforced; no test asks "did the README change?".

## 3. Design principles

1. **One agent, one conversation.** The agent that talks to the user does the work. Delegation is a tool it may use, never a required step.
2. **Use each model at its native level.** Native tool calling or a full agent runtime. No text shim.
3. **A model is given only work it has passed a test for.**
4. **Code decides "done".** Every task carries a check that code can run.
5. **Outcome evals gate every milestone.** The product is judged by tasks completed, on a fixed task set.

## 4. Architecture

```
webview ── host ── Core
                    ├─ Session        one per chat: full transcript (tool results included), persisted, resumable
                    ├─ Lead           the session's agent; answers, edits, runs, delegates
                    ├─ Engines        how an agent runs (below)
                    ├─ Tools          files, search, terminal, diagnostics; delegate, ask_user, load_skill, plan
                    ├─ Checks         per-task acceptance run by code
                    ├─ Policy         approvals, write paths, cost cap, ledger
                    └─ Config/Setup   channels, agents, roles, skills, wizard (kept)
```

### 4.1 Engines

One interface: `start(session, role) → events`, `send(message)`, `cancel()`. Events are text, tool request/result, approval request, usage, finished.

| Engine | For | How |
|---|---|---|
| `native-loop` | OpenAI-compatible, Ollama | Stewart's loop with the provider's native tool calling. Stewart executes the tools. |
| `claude-code` | Claude CLI subscription | The CLI runs as an agent in the project root with its own tools and a resumed session per chat. Stewart supervises: it answers permission requests through the existing approval cards, streams events to the webview, and records changed files. |
| `acp` (later) | Any ACP agent | Same supervision contract as `claude-code`. |

A model with no reliable native tool calling is not an agent. It can still serve as a **function**: one request, schema-constrained JSON out, no tools (summarise, classify, score one file).

### 4.2 Roles

Roles, agents, channels and skills stay as configuration. What changes is how a role is used.

- `lead` is the default role and replaces orchestrator, general-worker and code-writer. It has the full tool set and answers directly when no tools are needed.
- Other roles are **profiles the lead delegates to** with `delegate(role, task, check)`: a prompt, a tool subset, a model chain. Shipped set: `explorer` (read-only search), `reviewer` (read-only; code health is a skill on it), `tester`, `planner`. Document writing, image reading and similar become skills, not roles.
- Each role declares `kind: agent | function` and what it needs (tool calling, minimum context window, vision). Setup refuses an assignment that does not meet it.
- Delegation is for three cases only: read-only work that can run in parallel, work whose reading would flood the lead's context, and narrow checkable work a cheaper model is qualified for. One writer at a time, so leases and deadlock detection go away.

### 4.3 Model chain and escalation

Each role has an ordered chain of agents, cheapest first. A task runs on the first agent **qualified** for its kind. If its check fails, or the loop guard trips (same failing call twice, or N turns with no progress), the task moves to the next agent with a short handover: goal, what was tried, the failing evidence. The last step is to ask the user. This replaces `fallbackAgent`, recovery layers 0–1, the continue question and budget profiles.

Qualification comes from the setup wizard, which already benchmarks models. It adds a conformance suite per kind: for `agent`, a scripted multi-turn task (read a file, edit it, run a command, report); for `function`, schema-valid output. Results are stored with the channel.

### 4.4 Checks

`check` is data on the task, run by code after the agent stops:

- edit tasks: the named files changed (read-back) and, when given, a command exits 0 (tests, typecheck, lint);
- report tasks: the output validates against a schema and cites files that exist;
- question tasks: none; the reply is the result.

Run status is `done` only when the check passes. Otherwise it is `failed` with the evidence shown. `no_dispatch` is removed.

### 4.5 Context

- System prompt = role prompt + a one-line index of skills + bounded project notes. Skill bodies load on demand through `load_skill`.
- Minimum context window to act as an agent (proposed: 32k tokens). Smaller models are function-only.
- Compaction is one step: summarise older turns when the transcript passes a threshold, keeping the plan, the open task and the last turns.

### 4.6 Long builds

- The plan is a file (`.stewart/plan.md`): milestones, each with a check. The lead writes it in plan mode and the user approves it once.
- The lead works one milestone at a time. A passed check is followed by a checkpoint (git commit on a work branch, or a snapshot when the project is not a git repo). *Amended (§8.5):* the commit goes to `refs/stewart/<sessionId>`, not a branch, so the user's HEAD, branches and index are never touched. Revert restores a checkpoint.
- Resume reads the plan file and the session transcript. The idempotency log and journal replay are removed.

## 5. Kept, changed, dropped

| Kept | Changed | Dropped |
|---|---|---|
| Both hosts, sidecar transport, JCEF/webview shell | Core is rewritten around Session + Engines | Mandatory Orchestrator, `dispatch`, `no_dispatch` |
| Config files, three-layer merge, secrets | Roles gain `kind`, requirements, model chain | Text tool-call shim (`toolcall-format`) |
| Channel adapters for OpenAI-compatible and Ollama (native tools only) | Claude adapter becomes the `claude-code` engine | Recovery layers, task split, continue question |
| Setup wizard, probes, benchmarks | Wizard adds conformance qualification | Leases, deadlock detection, task graph |
| Approvals, permissions, ledger, cost cap, interaction queue | Checks decide run status | Idempotency log, journal replay |
| Chat history, images, mentions | History stores the full transcript | Plan/verdict/replacement verbs, `RunFeature` hook, budget profiles |

Target size for the new core: about 8 modules (`protocol`, `config`, `channels`, `engines`, `tools`, `session`, `tasks`, `policy`) plus `setup`. *Amended (§8.1 #9, #10):* the 17 layered modules stay; CI keeps the code gates (size, functions, coverage, layers, cycles) blocking, and the eval suite is the manual milestone gate because it needs live models and paid keys.

## 6. Build order

Each step ends with the eval suite run and its pass rate recorded.

0. **Eval suite first.** About 15 fixed tasks in a sample repo, scored by code: list a folder, summarise a diff, explain a function, edit one file, fix a failing test, add a function with a test, review a folder, a three-milestone feature. Run it against the current build for a baseline.
1. **Session + `native-loop` + lead**, one strong model, native tools, checks. Gate: question and single-file edit tasks pass.
2. **`claude-code` engine** with supervised permissions and session resume. Gate: the same tasks pass through Claude.
3. **Delegation**: `explorer` and `reviewer`, read-only, parallel. Code health becomes a reviewer skill with a schema check.
4. **Qualification + escalation**: wizard conformance suite, model chains, loop guard. Gate: tasks started on a local model finish, by themselves or after escalation.
5. **Long builds**: plan file, milestone checks, checkpoints, resume.
6. **Cut over**: migrate settings, delete the old modules, update `ARCHITECTURE_NOW.md`.

## 7. To verify before building

These are assumptions, not findings.

- The Claude Code CLI, run headless on the subscription, can (a) resume a session across turns, (b) route permission requests to Stewart, and (c) report file changes as events. A one-day spike decides between the CLI's stream mode and ACP.
-- a) when running claude from cli, it closes with the option to resume the same session with a uuid. Example prompt when exiting a session: '''Resume this session with:
claude --resume 85619c1b-bad8-4d19-bceb-d946f9e653dc'''
-- b) Permission requests will need to be tested.
-- c) File changes as events will need to be tested.
- Which configured models pass the agent conformance suite. If no local 7b–14b model does, local models are function-only and the cheap agent tier is the AI Factory models.
-- Local models are optional and are user-configured. See ./docker/ollama/models.txt and also /media/gdb/Data/Projects/AI_App/pull-local-models for available models. 
- AI Factory's proxy supports native tool calling for the models in use. Correct.
- JetBrains 2026.3 ships its own ACP agent support; check whether Stewart should register there instead of (or as well as) owning a chat panel. It would be great to use both as claude could then be instructed to call stewart's tools as well as other tools. Investigate and test this.

## 8. Remaining work (handover)

Audit of v3.0.0 (`8f17f4f`) against this plan on 2026-11-12. Code gates pass: build, typecheck, 1,227 tests, coverage, all `check:*` scripts. Gradle and the evals were not re-run for the audit. As-built detail: `docs/ai_docs/ARCHITECTURE_NOW.md`.

### 8.1 Gaps (closed 2026-11-12)

| # | Plan | Result |
|---|---|---|
| 1 | §4.4 report check on lead turns | Done: a turn with no file changes whose request reads as a review/report (`isReportGoal`) gets `cites: true`. |
| 2 | §4.3 first *qualified* agent | Done: `eligibleChain` runs only agents with a passing record for the role kind and a known window ≥ `needs.minContext` (default 32k). Unqualified agents no longer run; setup/Qualify must have run. |
| 3 | §4.4 edit check | Done: content is snapshotted before the first write and compared after (`unchanged:` fails); the lead declares a command with `set_check` (approval-gated). |
| 4 | §4.2 `delegate(role, task, check)` | Done: `check = {files?, command?}`; the command goes through the approval gate. |
| 5 | §4.2 one writer at a time | Done: write-capable children queue; read-only children stay parallel (cap 4). `delegate` now accepts write roles. |
| 6 | §4.1 `function` kind | Done: `runFunction` (engines) and `delegate({role, task, schema})` for `kind: function` roles. |
| 7 | §4.2 shipped roles | Done: `planner` (read-only) and `tester` (test paths only). |
| 8 | §4.5 compaction | Done: `session/compact.ts` (see ARCHITECTURE_NOW §6). |
| 9 | §5 gates vs evals | Decision: amend §5. Evals need live models and paid keys, so CI keeps the code gates blocking (size, functions, coverage, layers, cycles); the eval suite stays the manual milestone gate, recorded in EVALS.md. |
| 10 | §5 about 8 modules | Decision: amend the target. 17 manifest-layered modules stay; further merging adds churn without removing a failure mode. `check:layers` holds the dependency-count ratchet. |
| 11 | §7 JetBrains ACP | Investigated (web docs only, not tested in an IDE): AI Assistant has a built-in ACP client; agents are registered in `~/.jetbrains/acp.json` (`agent_servers`: command + args, stdio transport) or from the ACP registry, with `default_mcp_settings` (`use_idea_mcp`, `use_custom_mcp`) choosing which MCP tools the agent sees. Implication: Stewart can be offered as an ACP **agent** (stdio) in AI Assistant in addition to its own panel, and Claude Code run under ACP can be given Stewart's tools through MCP, which `claude-code` already does per turn (`engines/mcp.ts`). Not built; an `acp` engine/agent adapter is the next spike. Verify the exact `acp.json` keys against the 2026.2 help page first. |

### 8.2 Eval gates

| Step | Result | Open |
|---|---|---|
| 1 | Met: 14/15 on GLM; the failure passed on recheck | Re-run after §8 build |
| 2 | Met: 15/15 on Claude | Re-run after §8 build |
| 3 | `step3-local` 2/3 (question 1/1, report 1/2); see EVALS.md | Run the full suite |
| 4 | 13/15 on the local chain, 2 wrong `done` (CommonJS in ESM, uncited review) | Re-run: gaps 1–3 should turn both into honest failures or escalations |
| 5 | 15/15 on Claude; final `l-todo-cli` rerun `failed` (model chose `npm test` as the M3 check) | Re-run `l-todo-cli` |
| 6 | Met: 15/15 after cut-over | — |

The §8 changes were verified by unit tests, build, typecheck and all `check:*` gates only. **No eval was re-run** (they need live models and cost money); the eval configs carry qualification records so they still resolve a chain.

### 8.3 v2 leftovers (closed)

`wizard: true` now enables `lead`; `IdempotencyHooks` removed; wizard welcome text names lead/explorer/reviewer; `PROGRESS.md` already says `main`.

### 8.4 Audit fixes (2026-11-13)

An independent read of the code against §3–§6 found gaps the §8.1 build left open or introduced. All fixed with tests except the one marked; code gates pass; evals not re-run.

| # | Finding | Fix |
|---|---|---|
| 1 | Under `claude-code`, Stewart's MCP host tools were pre-allowed and ran unapproved, so a `set_check` command ran ungated | MCP `tools/call` puts `requiresApproval` tools through `turn.approve` first |
| 2 | `delegate`, `plan_write` and `milestone_done` hit the 120 s tool timeout; the child kept writing after the lead saw a failure | `noTimeout` honoured (delegate, milestone_done); `plan_write` is `awaitsUser`; dead `coreHandled` removed |
| 3 | A milestone failed 3 times was skipped and the plan could end `done`; the sweep auto-passed every pending milestone at once and ran milestone checks on unrelated turns | Current milestone = first not done (failed blocks); sweep checks only the current milestone and only after plan work; plan `done` only when every milestone is; files-only checks need a write since the last checkpoint |
| 4 | An edit request with no file change finished `done` (the step-4 wrong `done`s) | `isEditGoal` + `edit` check: some file must change (write tool or git worktree diff, so shell edits count) unless a declared command passed |
| 5 | The `unchanged:` check never fired under `claude-code` (absolute vs relative paths); children took no snapshots | Snapshots keyed by project-relative path; children snapshot and pass `before` to their check |
| 6 | Non-git revert: empty baseline, later-created files kept, state lost on resume; git revert rewrote `.stewart/plan.md` | Copy-on-write snapshot manifests on disk (`recordOriginal`); git revert skips `.stewart/`; revert resets later milestones to pending |
| 7 | The 32k minimum applied to `function` roles; `needs.vision` ignored at run time | 32k default for agents only; `agentRefusal` checks vision; unknown windows stay admitted (doc corrected — most providers report none) |
| 8 | Setup did not refuse unqualified or under-spec picks (AI-refine, Settings, assign) | Missing qualification refuses like a failed one; AI-refine uses role `kind`/`needs` and refuses unprobed models; `roles.assignAgent` refuses; Settings pickers list qualified agents; refused bound agents are config errors |
| 9 | A `claude-code` child ignored its role's tools and `writePaths` | `childPolicy.ts`: file edits need a write tool and a `writePaths` match; commands need `RunTerminal` |
| 10 | Compaction never ran inside a turn, failed for `claude-cli` leads, and overwrote saved history | `beforeModelTurn` hook compacts inside long native-loop turns (summarise the work between the task and the tail); skipped for `claude-cli`; archive chunks are expanded by `history.load` |
| 11 | Report check: "no issues" bypassed citations; root-level files and line numbers ignored | "No findings" needs a successful read; bare names count when the file exists; line numbers must be in range |
| 12 | Loop guard: narrow "no progress", none under `claude-code`; handover outcomes mismatched for batched calls | Shared `LoopGuard` (same call + same result ×3 added) used by both engines; `Tried` matched by `callId` |
| — | Low: no plan-first rule; delegation rule only implied; checks ran twice; stale CLI temp-dir notes; dead `shim`/`dependsOn`/`parked…`/`leadAgent`/image-role code; evals did not score the long-build path | `plan_write` refused after edits; lead prompt states the three delegation cases; check result reused; notes fixed; dead code removed (`shim` loads as `unknown`); `l-todo-cli` also requires a done plan with checkpoints (`planCompleted`) |
| — | **Not fixed:** `claude-cli` agents are still qualified by engine type without a run | A real run needs the live CLI working in a scratch directory during setup; kept as a documented exception |

### 8.5 Remaining deviations fixed and evals re-run (2026-11-13)

A second check of the build against §3–§6 left the items below. Code gates pass; evals were re-run (§8.2 table superseded by EVALS.md "2026-11-13 after the §8.5 fixes").

| # | Deviation | Result |
|---|---|---|
| 1 | §3.3: `claude-cli` agents qualified by engine type without a run | Fixed: the agent suite runs one real `claude-code` turn in a scratch directory (`setup/conformanceClaude.ts`); only edits inside it, `wc` and read-only calls are approved. |
| 2 | §4.5: an agent with an unknown context window was admitted | Fixed: when the provider reports no window, qualification runs a window probe (≈28k-token prompt, code word on line 1) and stores `context: 32000` in the record; `agentRefusal` refuses an unknown window. Records older than `QUAL_MIN_VERSION = 2` are refused ("qualification out of date"), so existing configs must run Qualify again. |
| 3 | §3.3: eval configs carried hand-written qualification records | Fixed: the eval runner strips all records and runs `setup.qualify` for real before the tasks (`packages/evals/src/qualify.ts`); the shipped configs carry none. |
| 4 | §4.1: function output was prompted and validated, not constrained | Fixed: the request carries the schema (`response_format: json_schema` for OpenAI-compatible, `format` for Ollama), retried once without it when the provider rejects the field; validation after the reply stays. |
| 5 | §4.4: the edit/report check was triggered only by regexes on the user's text | Fixed in part: the lead declares the kind with `set_task({kind: edit|report})`, which is data on the task. The declaration can only add a check; the regexes stay as the floor. A request the regex misses, on a turn where the model declares nothing, still gets no edit check. |
| 6 | §4.6: checkpoints are not on a work branch | Design amended (§4.6): `refs/stewart/<sessionId>` keeps the user's branches untouched. |
| 7 | Wrong `done` for CommonJS in an ESM project (step 4) | Not a deviation: §4.4 makes the command optional, so a file that changed passes. The model that produced it (qwen3.5:4b) had a hand-written record and fails the real agent suite, so it no longer runs as an agent. |

Findings from the run:

- **No local Ollama model passes the agent suite** (8 tried, see EVALS.md). Per §7 they are function-only (qwen3.5:9b and gemma4:12b pass the function suite) and the cheap agent tier is AI Factory `glm-5-3-flash`. AI Factory `qwen3-8-27b` also fails the agent suite (turn limit).
- Three local models fail by writing `ReadFile`'s `N: ` line-number prefixes back into the file. Whether the tool output should change is open.
- The step 4 gate ("tasks started on a local model finish, by themselves or after escalation") cannot be exercised: no local model may start a task. Escalation is covered by unit tests only.
- `claude-cli` agents cannot qualify for `kind: function` roles: the function suite uses `channel.chat`, which the Claude adapter does not serve.

Still open: ACP (§8.1 #11) and the two decisions amended in §5.

## 9. Design revision (2026-11-13) — built 2026-11-13 (code gates pass; evals not re-run)

A read of the v3.0.0 code for parts that work by guessing, by duplication or by convention. §3–§6 stay; this section tightens them.

### 9.1 Weak points as built

| # | Weak point | Where |
|---|---|---|
| 1 | Checks guess intent from the user's text. `set_task` is optional, so the regexes decide. | `tasks/checks.ts` `isEditGoal`, `isReportGoal`, `NO_FINDINGS` |
| 2 | Evidence is strings; pass/fail is decided by prefix and substring. A passing command whose argv contains ` exited ` counts as failed. | `tasks/checks.ts` `isFailure` |
| 3 | Three sources for "what changed": write-tool records, pre-write snapshots, git diff. Outside git, shell edits are invisible to checks and to checkpoints. | `session/turnState.ts`, `tasks/worktree.ts`, `tasks/checkpoint.ts` `recordOriginal` |
| 4 | The task loop (chain → attempt → check → escalate) is written twice, with a third check path for milestones. | `session/session.ts` `drive`, `session/child.ts` `runChild`, `session/plan.ts` `checkMilestone` |
| 5 | The model drives the plan: `milestone_done`, an end-of-turn sweep, a three-failure rule that is prompt text. A turn that ends mid-plan is `failed: plan incomplete`. One `.stewart/plan.md` per project: a second session's `plan_write` overwrites the first. | `session/plan.ts` |
| 6 | Role policy has two implementations and a hole. Native: `ToolRegistry.for(role)`. `claude-code` children: `childPolicy.ts`. `claude-code` lead: none, so the CLI may edit `.stewart/`, which native tools deny. | `tools/types.ts`, `session/childPolicy.ts`, `engines/claudeCode.ts` `answerControl` |
| 7 | Two conversation stores under `claude-code`. The CLI gets only the last user message; turns run by another engine in the same chat (mixed chain, escalation) never reach it. In reverse, a native model is sent CLI tool calls for tools it does not have. | `engines/claudeLines.ts` `userLine`, `recapPrefix` (stale resume only) |
| 8 | The session branches on `channel.cfg.type === "claude-cli"`. The engine contract hides that `claude-code` ignores `tools` and `beforeModelTurn`. Both engines hardcode `roleId: "lead"`. | `session/session.ts` `compact`, `engines/nativeLoop.ts` `invoke` |
| 9 | The transcript is saved only when the turn ends. A crash during a long build loses the turn. | `session/session.ts` `runTurn` |
| 10 | The model chooses its own exam (`set_check`), and a changed file with no command is `done` with nothing said about verification (the CommonJS case). | `session/sessionTools.ts` |
| 11 | `claude-cli` agents cannot serve `function` roles: the function path uses `channel.chat`, which that adapter does not implement. | `engines/functionRun.ts` |
| 12 | Escalation continues on the files a failed agent left. Outside a plan there is no way back. | `session/handover.ts` |

### 9.2 Rules added to §3

6. **Checks test facts and explicit contracts.** No check depends on intent read from prose.
7. **One implementation per concern**: one task runner, one policy decision, one change tracker.
8. **The result states how it was verified.** `done` never implies more than code confirmed.
9. **Code drives multi-step work.** The model works one task at a time.

### 9.3 Design

**Task runner.** `runTask(task)` is the only loop: eligible chain → engine attempt → verify → escalate → (interactive tasks only) ask the user. A lead turn, a delegated child and a milestone are all tasks. They differ in data: `role`, `transcript` (the session's or a fresh one), `hostTools`, `interactive`, `contract`.

**Contract.** A task's check comes from explicit sources only:

- project verify commands: `verify:` in `.stewart/project.yaml`, approved through the normal permission gate (an 'always' grant makes it once), run when the task changed files;
- the milestone check, approved with the plan;
- `delegate`'s `check` or `schema`;
- the lead's `set_check`, which may add a command (approval-gated) and never removes one.

`set_task`, `isEditGoal` and `isReportGoal` are removed.

**Verify.** Always tested, for every task: the engine stopped normally; the reply is non-empty or files changed; no path whose last write failed; changed paths are inside the role's `writePaths` and outside denied directories; the contract holds. A read-only child must also have one successful read, and every path and line it cites must exist (replaces the `NO_FINDINGS` regex). Lead replies are not citation-checked: a lead may name files that do not exist yet. Evidence is typed: `{code, ok, detail}`; a task passes when every item is `ok`.

`run.finished` gains `outcome: {changed: string[], verified: "command" | "files" | "none"}`. The webview shows it: "No files changed", "Changed 3 files, not verified", "Verified: pnpm test". A request for an edit that changed nothing is reported as exactly that.

**Change tracker.** One owner of "what changed": `begin() → baseline`, `diff(baseline) → paths`, `restore(baseline)`. In git: a tree written through the session's temp index under `refs/stewart/<sessionId>` (the index is kept between turns). Outside git: a hashed manifest of project files (ignore list, size cap); past the cap, tracking is `unavailable`, the outcome says so and revert is refused. Every task that can write takes a baseline, so a failed turn can be reverted and a checkpoint is a kept baseline. Write-tool records stay as UI events and are no longer check input.

**Plan.** `plan_write` → user approves → the session runs each milestone as a task, in order (goal = the milestone, contract = its check, transcript = the session's). Pass → checkpoint → next. Failed after the chain → ask the user (guidance to retry, or stop). Stopping leaves the plan `paused`; resume continues at the first milestone not done. `milestone_done`, the sweep, the attempts counter and `plan incomplete` are removed. Plan file: `.stewart/plans/<sessionId>.md`.

**Policy.** One function `decide(role, action) → allow | deny | ask`, `action = {kind: read | write | command | other, path?, command?}`. It holds the denied directories, `writePaths` and the read-only rule. Native tools call it before running; `claude-code` calls it for every `can_use_tool`, lead included. `childPolicy.ts` and the registry guards go. The verify step's path rule is the backstop: a change the policy would have denied fails the task whichever engine made it.

**Engines.** The contract gains `caps: {ownTools, ownContext}`, `turn.roleId`, and `complete(request) → JSON` for function tasks (`claude-code`: one CLI turn with no tools). The session reads `caps`, never the channel type. Context sync: `claude-code` state records how much of the transcript the CLI session has seen; messages added since by anything else are sent as a recap before the new message. The native loop renders tool calls from another engine as text.

**Persistence.** The transcript is saved after every model turn and tool batch. On load, a trailing tool call with no result is closed with an `interrupted` result.

**Escalation.** Unchanged, except the handover is built from typed evidence and the turn baseline lets the user revert a failed turn.

### 9.4 Build order

Code gates after every step; evals after steps 3 and 6.

1. Typed evidence; `outcome` on `run.finished`; remove the goal regexes and `set_task`. Done.
2. Change tracker; checks, checkpoints and revert use it; turn baselines. Done.
3. `runTask`; lead and children run on it. Done.
4. Code-driven plan; per-session plan file. Done.
5. `decide` policy and the path backstop; engine `caps`, `roleId`, context sync, `complete`. Done.
6. Incremental persistence. Done.

### 9.5 To verify before building

- Claude CLI flags for settings isolation: **verified 2026-11-13, CLI 2.1.323** — `--setting-sources ""` (no user/project/local settings → no pre-approval without `can_use_tool`), `--json-schema`, `--tools ""` are all accepted (the CLI parsed them and reached the API).
- **Verified 2026-11-13, CLI 2.1.323** (real calls once the API was reachable): auth works under `--setting-sources ""`; the `--json-schema` success envelope carries `structured_output` (real capture: `claude-complete-success.json`, `is_error: false`, `{"sum":42,"word":"trewts"}`); a `can_use_tool` reaches `approve` for the Edit (`preview {kind:"file", path:"notes/todo.txt"}`) and still does with a project `.claude/settings.json` allowing `Edit/Write/Bash` — project settings are not loaded under the empty flag. 
- Cost of `git add -A` into a kept temp index on a large repository, per turn: not measured.

# Stewart — New Design (2026-11-12)

Status: **accepted; steps 0–6 built as v3.0.0 (see EVALS.md); remaining work in §8**. Replaces the run/orchestration design in `docs/ai_docs/ARCHITECTURE_NOW.md`. Decisions taken with the user on 2026-11-12: all four kinds of work matter (code changes, reviews/reports, questions, long builds); cheap model first with automatic escalation; Claude Code CLI runs as a full agent; clean rewrite of the core.

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
- The lead works one milestone at a time. A passed check is followed by a checkpoint (git commit on a work branch, or a snapshot when the project is not a git repo). Revert restores a checkpoint.
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

Target size for the new core: about 8 modules (`protocol`, `config`, `channels`, `engines`, `tools`, `session`, `tasks`, `policy`) plus `setup`. The file-size and function-size gates stay as warnings; the eval suite becomes the blocking gate.

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

### 8.1 Gaps, in suggested order

The first three produce a wrong `done`, so they come first.

| # | Plan | Built | To do |
|---|---|---|---|
| 1 | §4.4 report tasks: schema + citations | Only delegated children get `cites`/`schema` (`modules/session/src/child.ts`). A lead report has no such check; two chain-local evals ended as a wrong `done` (review without citations). | Apply the report check to lead turns that are reports. |
| 2 | §4.3 a task runs on the first *qualified* agent | `eligibleChain` (`modules/roles-skills/src/chain.ts`) also tries agents with no qualification record. The 32k minimum context is enforced in setup only. | Run only agents with a passing record; enforce `minContext` at run time. |
| 3 | §4.4 edit tasks: named files changed, optional command | `turnCheck` (`modules/tasks/src/checks.ts`) only confirms that files the write tools touched exist and read back. A command check runs only for plan milestones. | Compare content before/after; let a lead turn carry a command check. |
| 4 | §4.2 `delegate(role, task, check)` | `delegate({role, task, report?})` | Add `check` (files, command) to `delegate`. |
| 5 | §4.2 one writer at a time | Up to 4 children run in parallel with no writer guard. Shipped roles are read-only, but custom roles can be added (`8f17f4f`). | Serialize children whose role has write tools. |
| 6 | §4.1 `function` kind | `kind: function` is used by qualification and assignment only; no run path. | Add a one-request, schema-constrained, no-tools run path. |
| 7 | §4.2 shipped roles | `lead`, `explorer`, `reviewer` | Ship `tester` and `planner`. |
| 8 | §4.5 one-step compaction | Not built (known gap in `ARCHITECTURE_NOW.md` §6). | Summarise older turns past a threshold; keep plan, open task, last turns. |
| 9 | §5 gates become warnings; evals block | CI (`.github/workflows/ci.yml`) still blocks on file size, function limits and coverage; evals are not in CI. | Decide: wire an eval run into CI and relax the size gates, or amend §5. |
| 10 | §5 about 8 modules + `setup` | 17 modules | Decide: merge modules or amend the target. |
| 11 | §7 JetBrains ACP | No record of the investigation; no `acp` engine (planned "later"). | Investigate and record the result. |

### 8.2 Eval gates

| Step | Result | Open |
|---|---|---|
| 1 | Met: 14/15 on GLM; the failure passed on recheck | — |
| 2 | Met: 15/15 on Claude | — |
| 3 | `packages/evals/results/2026-11-12-step3-local.json` (2/3) only | Record it in `EVALS.md`; run the full suite |
| 4 | 13/15 on the local chain, 2 wrong `done` | Re-run after gaps 1–3 |
| 5 | 15/15 on Claude; final `l-todo-cli` rerun ended `failed` (model chose `npm test` as the M3 check) | Re-run `l-todo-cli` |
| 6 | Met: 15/15 after cut-over | — |

### 8.3 v2 leftovers

- `handleRolesAssignAgent` with `wizard: true` enables `orchestrator` and `general-worker`, not `lead` (`packages/core/src/handlers/config.ts:126`); no caller passes `wizard`.
- `IdempotencyHooks` is still exported from `modules/kernel/src/wire.ts`; `ports.ts` still mentions the idempotency log.
- The wizard welcome text names "orchestrator, planner, code-writer" (`packages/webview/src/wizardStep0Welcome.tsx:8`).
- `docs/ai_docs/PROGRESS.md` header says branch `rebuild-v3`.

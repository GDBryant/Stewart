# Stewart — Architecture Diagrams

Rendered view of the code as built (v3.0.4). Prose source of truth: [`docs/ai_docs/ARCHITECTURE_NOW.md`](ai_docs/ARCHITECTURE_NOW.md). Update both in the same commit when modules, run paths, protocol, config or host wiring change.

## 1. Repo layout & runtime topology

```
packages/   protocol · core · sidecar · webview · evals (own suite + SWE-bench Docker runner)
modules/    17 × @stewart/<module> (strict layers, scripts/layers.json)
hosts/      vscode (TS, in-process core) · jetbrains (Kotlin + sidecar)
```

```mermaid
flowchart LR
    WV["webview bundle<br/>Preact: chat · settings · setup wizard<br/>(one bundle, both hosts)"]

    subgraph VSC["VS Code host (TypeScript)"]
        VS["host.ts — HostPort via vscode API<br/>routes.ts — webview message table + dispatchAndReply"]
        CORE1["core (in-process)"]
        VS --> CORE1
    end

    subgraph JBK["JetBrains host (Kotlin)"]
        JH["SidecarSupervisor (bundled Node, restart/backoff)<br/>HostRequestHandler · JCEF WebviewRouter"]
        SC["sidecar<br/>Node stdio JSON-RPC server<br/>rpc.ts · server.ts · host.ts"]
        JH <--> SC
    end

    CORE2["core — all logic, no host imports<br/>SessionService · ChannelService · ConfigStore · SetupService · Ledger"]

    WV -- "postMessage" --> VS
    WV -- "JCEF bridge" --> JH
    SC -- "stdio NDJSON JSON-RPC (packages/protocol)" --> CORE2
    SC -- "reverse-RPC → HostPort (files, secrets, logs)" --> JH
```

One chat path exists: the **lead session**. Every request flows `webview → host → (in-process | sidecar) → Core.dispatch → SessionService`.

Evals are host-free: the own suite runs tasks over a real `Core` + `nodeHost`; the SWE-bench runner lets the lead edit a host checkout of each official image's `/testbed`, then scores the `git diff` in a fresh container.

## 2. Module layers

17 `@stewart/<module>` packages; a module imports **only strictly lower layers** (`scripts/layers.json`, `pnpm check:layers`). Each package is composite with a 90/80 coverage gate.

```mermaid
flowchart TB
    L7["Layer 7 — setup · session"]
    L6["Layer 6 — engines"]
    L5["Layer 5 — tools"]
    L4["Layer 4 — context · tasks"]
    L3["Layer 3 — channels · ledger · permissions · roles-skills · code-health"]
    L2["Layer 2 — config · models · interaction"]
    L1["Layer 1 — catalog · diagnostics"]
    L0["Layer 0 — kernel (wire types, ports, EventBus, test fakes)"]
    L7 -->|"imports ↓ only"| L6 --> L5 --> L4 --> L3 --> L2 --> L1 --> L0
```

## 3. Lead run path (the one chat path)

```mermaid
flowchart TD
    U["user message"] --> HS["handleChatSend<br/>(host routes.ts)"]
    HS --> SS["SessionService.send<br/>(modules/session · runTask/turnState)"]
    SS --> HIST["ChatHistoryStore<br/>transcript + <id>.engine.json<br/>compaction before model turns"]
    SS --> CHAIN["eligibleChain<br/>(roles-skills chain.ts —<br/>qualified[kind], window, vision)"]
    SS --> PROMPT["lead system prompt + skill index<br/>+ context.loadProjectContext (8k cap)"]
    SS --> TOOLS["projectTools(...).for(lead)<br/>+ hostTools: delegate · health_report ·<br/>plan_write · load_skill · ask_user · set_check"]
    TOOLS --> ENG{"engineFor(channel)"}
    ENG -->|"claude-cli channel"| CC["claude-code engine<br/>claude -p stream-json subprocess<br/>--setting-sources '' · --resume · MCP hostTools<br/>claude.context observability"]
    ENG -->|"all other channels"| NL["native-loop engine<br/>channel.chat + native tools<br/>foreign names resolve · LoopGuard shared by both"]
    CC --> CH["channels<br/>ManagedChannel (retry/backoff) → adapter"]
    NL --> CH
    CH --> PR["provider APIs · ollama · claude CLI"]

    CC -- "tool.request / can_use_tool" --> PA["policyApprove → tools/policy.decide(role, action)<br/>→ permissions.gate → interaction card"]
    NL -- "preview + approve" --> PA
    PA -- "chat.approve / chat.answer" --> SS
    SS -- "run.* · text_delta · tool.* · check.result · claude.context" --> EV["packages/protocol → host → webview"]
    SS --> LED["ledger (per-run cost cap)"]
    SS --> TRK["tasks: changeTracker begin/diff/restore<br/>runCheck(declaredCheck(set_check) + project verify:)"]
    TRK -- "pass + engine stop → done<br/>else escalate next agent in chain" --> SS
```

Escalation: each failed attempt (check failure, engine error, `turn_limit`, `loop_guard`) appends a handover message, emits `run.escalated {from,to,reason}`, and moves to the next eligible agent; after the chain, one `ask_user` retry, then fail with evidence.

Process spawns are wrapped by kernel helpers: no inherited stdin except interactive `claude-code` and the sidecar RPC link, login-shell env at both host seams, one retry on the Windows start failure, and `done.cause`/`exitCause` text instead of bare exit codes. `claude.context` carries `cliSessionId`, `inputTokens`, `windowTokens`, `compacted` and `turnCount`; failed `run.finished` adds `contextAtFailure: "<tokens>/<window>"`.

## 4. Delegation (depth 1)

```mermaid
flowchart TD
    LEAD["lead runTask"] -->|"delegate(role, task, report?, check?, schema?)"| CR["ChildRunner<br/>cap 4 concurrent · read/write FIFO lock · no prompts"]
    CR --> C["child runTask (interactive: false)<br/>contract = delegate check (+ project verify: for writers)<br/>+ cites + needsRead for read-only roles"]
    C --> RO["explorer · reviewer · planner — read-only<br/>(read-only terminal allow-list:<br/>safe redirects/version probes; no test runners)"]
    C --> TST["tester — writes only writePaths (test files)"]
    C --> FN["kind: function → engine.complete(schema)<br/>native responseSchema · claude -p --json-schema"]
    RO --> ENG2["engineFor — same engine as lead<br/>(native-loop or claude-code)"]
    TST --> ENG2
    C --> POL["policyApprove(role, gate) per child<br/>+ verify-time policy_violation backstop"]
    C --> OUT["task.created/started/done/failed events<br/>child transcript <stateDir>/sessions/<sid>/<taskId>.json"]
    C --> HR["health_report → code-health merge/aggregate<br/>→ .stewart/reports/health-<runId>.md"]
```

Children never get `delegate`/`health_report` (depth 1). A failed child is a tool success carrying `status: failed` + evidence, not an error.

## 5. Config and state files

```
~/.config/stewart/                     one dir per OS, shared by both IDEs and projects
  channels.yaml · agents.yaml · roles.yaml · settings.yaml
  skills/                              skills/<name>/SKILL.md
<project>/.stewart/                    project layer (trusted workspaces only)
  project.yaml                         verify: argv contract commands
  roles.yaml · skills/ · scratch/
  plans/<sessionId>.md                 plan_write plans (active|paused|done)
  reports/health-<runId>.md
<stateDir>/ (per workspace, via HostPort)
  ledger.jsonl
  sessions/<id>.engine.json · <id>.turn · <id>.plan · <id>.archive.jsonl
  sessions/<id>/<taskId>.json          child transcripts
  checkpoints/<sessionId>/             tracker manifests + content-addressed blobs
  checkpoints/<sessionId>.index        persistent temp git index → refs/stewart/<sessionId>
  qualify/<uuid>/                      agent-suite scratch dirs
  setup-draft.json                     wizard drafts, 7-day expiry
```

Merge order for model facts / config: user YAML > probe cache > bench `perf` > catalog/price; roles compose effective config in `roles-skills/effective.ts`.

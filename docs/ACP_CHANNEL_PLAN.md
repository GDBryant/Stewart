# ACP channel/engine plan

Add a generic Agent Client Protocol (ACP) channel + engine so Stewart can drive
ACP-speaking agents — first target `devin acp` (user's Windsurf/Devin account),
later any ACP agent (`claude-code-acp`, `gemini-cli --experimental-acp`, etc.).

Status: plan, not built.

## Why

- PyCharm's Cascade plugin = `codeium-2.12.28.jar` + `language_server_linux_x64`
  speaking Connect-RPC/protobuf on localhost. Verified live: works, but needs
  `metadata.api_key` (not recoverable from env/config — likely JetBrains
  PasswordSafe), undocumented proto schemas, grpc-web streaming. Fragile,
  ToS-gray. Rejected as v1.
- `devin acp` is an official stdio ACP server, already installed at
  `/usr/share/devin-desktop/resources/app/extensions/windsurf/devin/bin/devin`,
  authenticated via `devin auth login` (`~/.local/share/devin/credentials.toml`).
  ACP is an open protocol (https://agentclientprotocol.com). Cheap and robust.

## Current state (verified 2026-11-17)

- `devin acp --help`: flags `--agent-type {summarizer|review|codemap}` (default =
  full agent), `--model <fuzzy name>` / `DEVIN_MODEL`, `--refusal-fallback`,
  `--cloud`, `--process-model {daemon|in-process}`.
- `devin models` / `devin auth status` on this machine report **not logged in**
  even though Devin Desktop runs — Desktop auth and CLI credentials may differ.
  Open question Q1 below.
- Channel types are an open set via `ChannelRegistry`; `claude-cli` is the
  precedent: adapter does login/listModels/probeCaps, `chat()` throws
  `use_engine`; the real work happens in `modules/engines` (`claudeCodeEngine`).
- `engineFor(channelType)` in `modules/engines/src/engineFor.ts` picks the
  engine; `Engine.id` union is `"native-loop" | "claude-code"`.
- MCP precedent: `modules/engines/src/mcp.ts` serves Stewart host tools over a
  localhost HTTP MCP server with a bearer token; `session/new` in ACP also
  accepts `mcpServers`, so the same handle can be reused.

## Design

### Channel: `type: "acp"`

New `AcpAdapter` in `modules/channels/src/acp/` mirroring `claude/adapter.ts`:

- `type = "acp"`.
- Config fields (channel schema is loose — `ChannelConfig` allows extras, but
  add explicit optional fields to `channelSchema` in
  `modules/config/src/schema.ts` for discoverability):
  - `cliPath?: string` — default: resolve `devin` on PATH, else the known
    Devin Desktop path above. Generic ACP agents set this to their binary.
  - `agentArgv?: string[]` — extra argv, e.g. `["acp", "--agent-type", "review"]`.
    Default `["acp"]`.
  - `agentType?: string` — convenience for `--agent-type`.
  - `authArgv?: string[]` — login probe argv; default `["auth","status"]`,
    empty array skips the probe (generic agents).
  - `extraEnv?: Record<string,string>` — passed to child env (existing pattern
    in `claudeChildEnv`).
- `listModels(cfg)`: models come from `devin models` (non-ACP subcommand) when
  cliPath is devin; for generic ACP agents fall back to `cfg.extraModels` or a
  static list. Simplest v1: return `cfg.extraModels` normalized, or
  `["default"]` when empty, and let `modelCaps`/`extraModels` carry real model
  ids. `AgentDef.model` reaches the engine via spawn `--model` when supported —
  see Q3.
- `probeCaps()`: `{ tools: "native", reasoning: true }` — ACP agents run their
  own tools; context size unknown → leave `contextTokens` unset.
- `loginStatus(cfg)`: spawn `<cliPath> auth status` with a timeout like
  `authProbe`; `authArgv: []` skips (return loggedIn true).
- `chat()`: throw `ChannelError(..., "use_engine")` — same as claude-cli.

### Engine: `acp`

New `modules/engines/src/acp.ts` + `acpClient.ts` for the JSON-RPC plumbing.
Prefer one file <500 lines; `acpLines.ts` only if line parsing earns its keep.
Respect `check:functions` (≤40 code lines, complexity ≤10, depth ≤3, ≤4 params)
and `check:boundaries` (>300 warns, >500 fails).

`acpEngine(deps)` returns `Engine` with `id: "acp"`, `caps: { ownTools: true,
ownContext: true }` (agent owns tools and context, like claude-code).

`run(turn)` flow:

1. Spawn `cliPath agentArgv` via `SpawnFn` (`nodeSpawn` from channels —
   injectable for tests), `cwd: turn.cwd`, env = `process.env` + `extraEnv`
   (do NOT strip credentials; devin auth lives in credentials.toml).
2. JSON-RPC 2.0 over stdio — confirm framing against the ACP spec and a live
   `devin acp` handshake (Q2). Client→agent requests need ids; agent→client
   requests (`session/request_permission`, `fs/*`, `terminal/*`) must be
   answered or the turn stalls.
3. `initialize` → `{ protocolVersion, clientCapabilities: { fs: { readTextFile:
   false, writeTextFile: false }, terminal: false } }` — minimal caps so the
   agent uses its own tools; revisit if we want to serve host fs.
4. `session/new` `{ cwd, mcpServers: [...] }` — when `turn.hostTools` exists,
   reuse `startMcp` from `mcp.ts` and pass its URL/token as an MCP server entry
   (ACP `mcpServers` shape: `{ name, command|url, ... }` — verify exact schema;
   check whether devin supports the HTTP/SSE variant our handle exposes).
   Persist returned `sessionId` in `turn.state.acpSessionId` for resume across
   turns (v1: one session per Stewart chat session).
5. `session/prompt` `{ sessionId, prompt: [{ type: "text", text }] }` — render
   the transcript delta like `userLine(turn.transcript, prefix)` in
   `claudeLines.ts` (extract/share if clean, else duplicate minimally).
6. Stream `session/update` notifications → `EngineEvent`:
   - `agent_message_chunk` → `text`
   - `agent_thought_chunk` → `reasoning`
   - `tool_call` → `tool.request` (map `kind`, `title`, `rawInput` → args;
     `category` via `previewFor`/`categoryOf`)
   - `tool_call_update` (status completed/failed) → `tool.outcome` + `write`
     record for file-editing tool kinds (ACP `tool_call.kind` values `edit`,
     `delete`, `move` → WriteRecord)
   - usage notification → `usage` event (fields vary by agent; tolerate
     missing)
   - `plan` → optional: emit as reasoning or ignore v1
7. `session/request_permission` (agent→client request) → build `ToolCall`, call
   `turn.approve(call, preview, { roleId })`, respond with the selected option
   id or cancelled — exact option shape per spec (Q4); pick the allow-ish
   option heuristically (name matches allow/always-allow/proceed).
8. `session/cancel` notification on `turn.signal` abort; SIGTERM after grace
   like `cancelWatch` in claudeCode.ts.
9. End: `finished` reason `stop` on prompt response `stopReason`, `cancelled`
   on abort, `error` on JSON-RPC error / spawn failure. Record usage into
   `turn.state` if the protocol reports it.
10. `complete(req)`: v1 return `{ ok:false, error:"acp channels do not support
    function tasks" }` AND guard upstream: `modules/setup/src/recommend.ts` /
    role assignment must not bind `kind:"function"` roles to acp agents —
    check where claude-cli is excluded today and mirror it. (Alternative if
    needed later: `--agent-type summarizer` + JSON-only prompt; not v1.)

`engineFor`: `if (channelType === "acp") return acpEngine()`; widen `Engine.id`
to include `"acp"`. Check everywhere `engine.id`/`channelType` is switched
(session, setup, catalog, webview labels) — grep `"claude-code"` and
`"claude-cli"` for all touchpoints.

### Config / setup / catalog touchpoints

- `modules/config/src/schema.ts`: add the new optional channel fields above.
- `modules/channels/src/api.ts`: export `AcpAdapter` + deps types.
- `packages/core/src/core.ts`: `this.channels.register("acp", (d) => new
  AcpAdapter(d as ChannelDeps))`.
- `modules/setup/src/recommend.ts` + `conformance*.ts`: setup auto-detection of
  the `devin` binary (probe `devin auth status`) as a channel candidate — v1:
  manual config only; add detection as a follow-up if cheap.
- `modules/catalog`: devin model ids are fuzzy (`devin models`); normalize via
  existing `normalizeModel`.
- Webview: channel type label/icon — check `packages/webview` channel-type
  switches.

## Open questions (resolve during implementation, in order)

- Q1 auth: `devin auth status` says not logged in while Devin Desktop works.
  Does `devin acp` share Desktop credentials or need `devin auth login`? Test:
  spawn `devin acp`, send `initialize`, see if `authenticate` is required and
  which methodId. If login needed, document `devin auth login` as setup step.
- Q2 protocol framing: confirm newline-delimited JSON-RPC vs Content-Length
  headers by hand-shaking `devin acp` (send `initialize`, read response).
  Spec: agentclientprotocol.com (rust crate `agent-client-protocol`, schema in
  `schema/` of the repo — download `schema.json` for exact types).
- Q3 model selection: does `session/new` or a `session/set_model`-style method
  exist in devin's ACP dialect, or is `--model` at spawn the only knob? If
  spawn-only, engine spawns per turn (already does) and `AgentDef.model` →
  `--model <model>` argv. `--agent-type` fixed per channel, not per agent.
- Q4 permission option ids: capture real `session/request_permission` payloads
  from `devin acp` to map allow/deny correctly.
- Q5 `--process-model`: default `daemon` shares a background daemon across
  clients — probably fine (sessions keyed by id); `in-process` isolates. Start
  with default; note daemon reuse means `session/cancel`/kill semantics differ.

## Tests (repo rule: positive + negative, ≥90% line / ≥80% branch coverage)

- `modules/channels/test/acp.test.ts`: adapter with fake SpawnFn —
  listModels extraModels path, loginStatus ok/fail/timeout, chat() throws
  use_engine, unknown cliPath error.
- `modules/engines/test/acp.test.ts`: fake ACP agent — a small Node script (or
  in-process fake SpawnedProc emitting canned JSON-RPC lines) covering:
  - happy path: initialize→session/new→prompt→chunks→stop→`finished:stop`,
    text+reasoning+tool events mapped, usage recorded
  - `session/request_permission` approved and denied
  - abort mid-stream → cancel sent, `finished:cancelled`
  - malformed JSON line ignored; JSON-RPC error → `finished:error`
  - spawn failure → `finished:error` with message
  - hostTools → mcpServers passed to session/new; close on finish
  - session resume: second turn reuses `state.acpSessionId`
  - `complete()` returns unsupported error
- Update `engineFor` tests, config schema tests (new fields parse/defaults),
  setup/recommend exclusion tests for function roles on acp.
- Fixture: record one real `devin acp` transcript (initialize + prompt) as a
  test fixture if license/size allows; otherwise hand-written per spec.

## Docs to update in the same commits

- `docs/ai_docs/ARCHITECTURE_NOW.md` — new channel type, engine, run path.
- `docs/ai_docs/PROGRESS.md` — milestone row when landed.
- `docs/ai_docs/SETUP.md` — if setup detection is added.
- `AGENTS.md` — move this file reference once built (or mark superseded).
- `docs/ai_docs/COMPATIBILITY.md` — pinned `devin` CLI version note.

## Suggested build order

1. Spike (no commit): handshake `devin acp` manually, answer Q1–Q4, record
   findings at top of this file.
2. `AcpAdapter` + registration + schema fields + tests.
3. `acpClient` JSON-RPC core + `acpEngine.run` happy path + tests.
4. Permission/fs/terminal request handling + abort + resume + tests.
5. hostTools MCP bridging + `complete()` guard + setup exclusion + tests.
6. Docs sweep, `pnpm -r test typecheck`, `pnpm check:*` gates.

## Risks

- `devin` CLI auth may be separate from Desktop login (Q1) — worst case the
  channel is unusable until `devin auth login`; generic ACP agents unaffected.
- ACP spec is young; devin's dialect may add proprietary methods — isolate all
  protocol knowledge in `acpClient.ts`.
- Agent owns its tools: Stewart permission gate only sees
  `session/request_permission` events — verify devin actually routes dangerous
  ops through it (it should; that's the protocol's purpose). If not, treat
  channel as untrusted and note it in docs.
- Daemon mode (`--process-model daemon`) may already be running under Devin
  Desktop; our spawned `devin acp` joins the same daemon — session ids must not
  collide (they're UUIDs; fine) but test that a Stewart-spawned client doesn't
  disturb Desktop sessions.

## File checklist

- `modules/channels/src/acp/adapter.ts` (new)
- `modules/channels/src/api.ts` (export)
- `packages/core/src/core.ts` (register `"acp"`)
- `modules/config/src/schema.ts` (channel fields)
- `modules/engines/src/acp.ts`, `acpClient.ts` (new)
- `modules/engines/src/types.ts` (`Engine.id` union)
- `modules/engines/src/engineFor.ts` (route `"acp"`)
- `modules/setup/src/recommend.ts` (+ conformance) — function-role exclusion
- `packages/webview` — channel type display (grep `claude-cli`)
- tests: `modules/channels/test/acp*.test.ts`, `modules/engines/test/acp*.test.ts`,
  config/setup test updates
- docs: ARCHITECTURE_NOW, PROGRESS, SETUP/COMPATIBILITY as applicable

Note: keep every new file under the 500-line `check:boundaries` fail limit and
functions within `check:functions` limits; run `pnpm check:layers` after wiring
deps (`acpClient` should need node stdio only, so likely no new deps).

## Out of scope (v1)

- Language-server Connect-RPC adapter (Windsurf Cascade raw models).
- `--cloud` relay mode, `--agent-type` per-role mapping, ACP `terminal/*`
  capability serving, fs capability serving.
- Setup-wizard auto-detection of `devin`.

## Handoff notes

- Repo: `/media/gdb/Data/Projects/Stewart`. Build: `pnpm -r build`,
  test `pnpm -r test`, gates `pnpm check:layers check:boundaries check:cycles
  check:tsrefs check:docs check:functions`.
- Precedent to copy: `claude-cli` channel (`modules/channels/src/claude/`) +
  `claudeCodeEngine` (`modules/engines/src/claudeCode.ts`) — same adapter/
  engine split, same spawn/approve/state patterns.
- ACP spec: https://agentclientprotocol.com — fetch `schema.json` from the
  `zed-industries/agent-client-protocol` repo for exact method/field names
  before coding `acpClient.ts`.
- Do not push to origin (repo rule). Update ARCHITECTURE_NOW.md in the same
  commit as any module/run-path change.

*Generated during investigation of Windsurf/Devin account reuse; spike results
should be appended under "Open questions" as they land.*<|end_message|><|message_model|><|content_thinking|>Now add AGENTS.md reference. Find the References section — add line after SETUP.md or near end of ai_docs list. Insert after the HANDOVER line maybe; simplest: add after SETUP.md line.<|end_message|><|message_model|>edit<|content_invoke_tool_json|>{
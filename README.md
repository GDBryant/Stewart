# Stewart

**An AI coding assistant inside your JetBrains IDE — local or enterprise models, file edits and terminal commands, with configurable approval controls.**

Stewart adds a chat tool window to IntelliJ IDEA, PyCharm and other 2025.1+ JetBrains IDEs. It talks to **Ollama** (local), **AI Factory** (OpenAI-compatible proxy) and **Claude** (enterprise, via the Claude Code CLI and SSO), can read, search and edit your files, and can run shell commands — with reads and searches running automatically when tools are enabled. Edits and commands require approval unless covered by an existing grant. Approvals can be scoped to a single call, a chat, or a project.

[![Build](https://github.com/GDBryant/Stewart/actions/workflows/build.yml/badge.svg)](https://github.com/GDBryant/Stewart/actions/workflows/build.yml)
![Platform](https://img.shields.io/badge/platform-2025.1%2B-blue)
![Kotlin](https://img.shields.io/badge/Kotlin-2.2-7F52FF?logo=kotlin&logoColor=white)
![Java](https://img.shields.io/badge/Java-21-orange)

---

## Why another AI plugin

- **Your models, your machine.** Local Ollama models work fully offline; remote providers are optional and configured per IDE.
- **Approval controls.** File writes and commands prompt unless already granted. Program-based grants require parseable shell commands; category-wide Commands grants bypass that restriction.
- **Mixed-model economics.** Run a strong model as planner/executor and a fast local model as the worker, so cheap models do the bulk of the work.
- **Auditable.** Auto-approved calls are logged when debug logging is on; grants are visible and revocable from chat or settings.

## Features

### Chat and models

- Right-side **Stewart** tool window with markdown replies, model picker and streaming with cancel.
- **Ollama** models listed live from `/api/tags`; **AI Factory** models configured by ID; **Claude** models via the Claude Code CLI with enterprise SSO (no API key stored in the IDE).
- **Single-model mode** — one model for the whole conversation.
- **Multi-model mode** — a three-level orchestrator: *Planner* → *Executor* → *Worker*, each bound to its own model. `/model <role> <provider/model>` switches a role mid-session.

### Tools

| Tool | What it does | Approval |
|------|--------------|----------|
| `ReadFile` | Read a file in the project | automatic |
| `FindFiles` | Glob for files by name | automatic |
| `Search` | Search file contents | automatic |
| `WriteFile` | Create or overwrite a file | gated |
| `EditFile` | Apply an edit / patch | gated |
| `RunTerminal` | Run a shell command in the project | gated |

File tools are confined to the project roots (symlinks resolved). Native tool calls are the default; a deprecated text `<tool_call>` shim remains as a per-model fallback for providers that cannot emit native calls.

### Approvals and permissions

When no existing grant covers an action, its preview dialog offers three scopes:

- **Just once**
- **Allow for this chat**
- **Always allow in this project**

Grants can be per **category** (edits / commands / other) or per **program** (`git`, `gradle`, `ls`, …). Command grants match parsed program names, not arguments — so "allow `git`" also covers `git push`, by design. Unparseable commands cannot receive a program grant. They prompt unless a category-wide Commands grant is active.

Manage grants from three places:

- the **Bypass** button in the chat header (per-category ticks, chat-grant counter, "Clear chat grants");
- **Settings → Stewart** (project section): ticks, always-allowed program list, stored project path, reset-all-projects;
- the **`/permissions`** slash command: list, `clear`, `revoke <target>`, `reset`, `revoke all`.

Permissions are stored per project (`locationHash`) in application-level state, deliberately excluded from Settings Sync, and never written into the repository. Chat grants are in-memory and disappear when the chat is cleared or the IDE restarts.

### Context, cost and observability

- Auto-compaction at a configurable token threshold, plus `/compact`.
- Chat history retention with a configurable day limit.
- `/cost` reports token use and cost for the chat.
- Optional debug logging: JSONL record of every model call (with redaction) and of auto-approved tool calls.

### Slash commands

| Command | Purpose |
|---------|---------|
| `/help` | List commands |
| `/clear` | Clear conversation and saved history |
| `/cost` | Token use and cost for this chat |
| `/compact [focus]` | Compact now, optionally keeping a focus |
| `/init` | Prepare `AGENTS.md` and `docs/ai_docs`, then investigate |
| `/review [focus]` | Review uncommitted changes (`git diff HEAD`) |
| `/model [role] [provider/model]` | Show or switch model (per role in multi-model mode) |
| `/config` | Open plugin settings |
| `/permissions [clear\|reset\|revoke <target>]` | List or change approval permissions |

Type `//` to send a literal `/`.

## Requirements

- Declared platform support: **2025.1 or newer** (build 251+). Plugin Verifier targets **IntelliJ IDEA Community 2025.1** and **PyCharm Professional 2025.3**; other products and newer versions are not automatically verified. See [compatibility notes](docs/COMPATIBILITY.md) for the recorded results and verification caveats.
- **JDK 21** to build from source; not needed to run the plugin.
- At least one provider:
  - **Ollama** running locally (default `http://localhost:11434`), or
  - an **AI Factory** base URL and API key, or
  - the **`claude` CLI** installed and logged in with your enterprise account.

## Installation

### Build from source

```bash
git clone https://github.com/GDBryant/Stewart.git
cd Stewart
./gradlew buildPlugin
```

The plugin zip is written to `build/distributions/`. In the IDE, open **Settings → Plugins → Install Plugin from Disk…** from the settings menu, select the zip and restart.

On Windows, use `gradlew.bat` instead of `./gradlew`. The helper script below requires a Unix-style shell.

### Download a CI build

Open the [Build workflow](https://github.com/GDBryant/Stewart/actions/workflows/build.yml), select a successful run for the revision you want, and download its `stewart-plugin` artifact. Extract the artifact archive, then install the plugin zip inside it using **Install Plugin from Disk…**. Artifact downloads require GitHub sign-in and are subject to retention limits.

To install into every locally detected IDE in one step:

```bash
scripts/install-plugin.sh              # build and install
scripts/install-plugin.sh --no-build   # reuse the existing build
```

### Development sandbox

```bash
./gradlew runIde
```

launches a disposable IDE with the plugin installed.

## Getting started

### Quick start with local Ollama

1. Install Ollama and download a model suitable for your machine using `ollama pull <model-name>`. Start its server with `ollama serve` if it is not already running.
2. Check that `ollama list` shows the downloaded model.
3. In **Settings → Tools → Stewart**, set **Ollama URL** to `http://localhost:11434` and apply. For the first chat, leave tools disabled.
4. Open the **Stewart** tool window, select your downloaded model and send: **“Explain the difference between a unit test and an integration test.”** A streamed response confirms the connection.
5. Enable tools in settings and try: **“Find the project's build configuration and summarize how to run its tests. Do not edit files or run commands.”** Use a tool-capable model for this step.
6. To exercise approval safely, keep bypass grants off and ask: **“Run git status and summarize the result.”** Review the command and working directory, then approve **Just once**.

Local use needs no AIF or Claude credentials. Downloading models requires network access; once downloaded, local inference does not require a remote provider.

### Provider and session settings

1. **Configure a provider** — **Settings → Tools → Stewart**:

   | Setting | Notes |
   |---------|-------|
   | Ollama URL | Defaults to `http://localhost:11434` |
   | AIF base URL / API key | OpenAI-compatible endpoint; the key is stored in the IDE password store |
   | AIF extra models | One model ID per line |
   | Claude CLI path | Path to `claude`; the login status check verifies SSO |
   | Claude models | One CLI alias or model ID per line |
   | Tool path overrides | Per-model `NATIVE`/`SHIM` tool-call path |
   | Enable tools | Master switch for read/search/edit/run |
   | Auto-compact context at (tokens) | Compaction threshold |
   | Keep chat history (days, 0 = don't save) | Retention |
   | Debug log / folder / retention | Call logging |

2. **Open the Stewart tool window** on the right edge, pick a model in the header and start chatting. `/help` lists the commands.
3. **Approve as you go.** File edits and commands open a preview dialog. Choose a scope, or grant the specific programs shown for a command.
4. **Review what you granted.** The header shows the active bypass state and a `+N` chat-grant count; `/permissions` prints the full picture.

## Security model

Stewart is a coding agent, not a sandbox. Its intended protections are:

- File tools validate paths against project roots, including resolved symlinks.
- Edits and commands require approval or a matching grant; reads and searches run automatically when tools are enabled.
- Program-based command grants require successful parsing and coverage of **every** parsed program. A category-wide Commands grant bypasses this restriction, including for unparseable commands.
- Permission lookup or parsing errors fall back to prompting. Unknown tool names are rejected; unknown approval previews are not bypassed.

Program grants cover all arguments and any working directory allowed by the command tool, including destructive invocations of an allowed program. Commands start within project roots but run with your user privileges and **can access files outside the project or contact the network**. Review previews, keep grants narrow, and use version control or backups.

Revoke grants with `/permissions revoke <target>` or `/permissions reset`. Revocation affects subsequent approval checks; it does not undo actions or stop an already-running command.

See [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) for the full rule set, parser rejections and storage details.

## Privacy and data handling

- **Local Ollama:** model requests go to your configured Ollama endpoint. A local endpoint keeps inference on your machine; a remote Ollama URL sends requests to that host.
- **Remote providers:** supplied conversation content and tool results, including file contents read by the assistant, may be sent to AIF or Claude. Check your provider's retention policies and your organization's rules before using private code.
- **History and logs:** saved conversations and optional debug logs may contain source code, prompts and command output. Redaction is not a guarantee that every secret is removed. Review retention settings and inspect logs before sharing them.
- **Credentials:** keep API keys out of prompts, source files and issue reports. AIF credentials use the IDE password store; Claude authentication is handled through the CLI login.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Ollama model list is empty | Confirm the server is running, check `ollama list`, and verify the Ollama URL. If Ollama runs in a container or on another host, `localhost` may not reach it from the IDE. |
| Connection refused or timeout | Check the endpoint, port, proxy and firewall. Test reachability from the machine running the IDE. |
| Claude login or executable error | Confirm the configured CLI path, verify the CLI works outside the IDE, and use the settings login check. See [Claude transport notes](docs/CLAUDE_FEASIBILITY.md) for supported CLI assumptions. |
| The model describes actions but does not call tools | Check **Enable tools**, select a tool-capable model, and review its native/shim override. Do not blindly retry if an action may already have executed. |
| Commands unexpectedly skip approval | Run `/permissions` and inspect category, chat and program grants. Use `/permissions revoke all` to remove this project's active grants. |
| Plugin does not appear | Confirm the IDE build is 251+, install the plugin zip rather than its enclosing artifact archive, and restart the IDE. |

For a bug report, include your IDE version, Stewart version, provider/model, steps to reproduce and a sanitized error. Never attach raw credentials or unreviewed debug logs.

## Architecture

```
Tool window (chat UI, model picker, mode toggle, approval dialogs)
      │
  Orchestrator — Planner / Executor / Worker (one ModelRef each)
      │
  ToolLoop — conversation, bounded model↔tool cycles, cancellation
    ├── ModelProvider ─ Ollama · AI Factory · Claude CLI
    └── ToolRegistry → validate → approve → execute → correlated result
```

Kotlin throughout, Swing UI, coroutines for I/O, no bundled Node runtime. Full design, execution contract and provider details: [`docs/PLAN.md`](docs/PLAN.md).

## Building and testing

```bash
./gradlew test          # unit + integration tests (live tests skipped by default)
./gradlew koverVerify   # coverage gate: ≥90% line, ≥80% branch
./gradlew buildPlugin   # plugin zip
./gradlew verifyPlugin  # IntelliJ Plugin Verifier against IC 2025.1 and PyCharm 2025.3
```

Optional live tests (need credentials/services):

```bash
OLLAMA_LIVE=1 ./gradlew test --tests '*OllamaLiveTest*'
AIF_LIVE=1 AIF_BASE_URL=... AIF_API_KEY=... AIF_MODEL=... ./gradlew test --tests '*AifLiveTest*'
CLAUDE_LIVE=1 ./gradlew test --tests '*ClaudeLiveTest*'
```

CI (`.github/workflows/build.yml`) runs `buildPlugin check verifyPlugin koverXmlReport` on every push and pull request and uploads the plugin zip and coverage report.

### Project layout

```
src/main/kotlin/com/adb/stewart/
  ui/            chat panel, tool window, approval dialogs
  tools/         tool registry, project tools, tool loop
    permissions/ categories, grants, shell splitter, project permissions
  provider/      Ollama, AI Factory, Claude CLI, shim
  orchestrator/  planner/executor/worker, role routing
  chat/          chat session, slash commands
  settings/      settings state, configurables
docs/            design, permissions, compatibility, roadmap
scripts/         install-plugin.sh, claude-feasibility.sh
```

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/PLAN.md`](docs/PLAN.md) | Architecture, providers, execution contract, milestones |
| [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) | Approval categories, grants, parser rules, storage |
| [`docs/PHASE2.md`](docs/PHASE2.md) | Phase 2 roadmap (orchestration, sessions) |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | Verified IDEs, pinned toolchain |
| [`docs/DEBUG_LOGGING.md`](docs/DEBUG_LOGGING.md) | Log format, redaction, retention |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Milestone status |
| [`AGENTS.md`](AGENTS.md) | Contributor commands and conventions |

## Contributing

Issues and pull requests are welcome. Please:

- keep changes small and focused;
- add tests for both positive and negative behaviour — every change ships tests;
- make sure `./gradlew test` and `./gradlew koverVerify` pass locally before opening a PR.

## License

No license has been published for this repository yet. Until one is added, the default copyright applies — please open an issue if you would like to use the code.

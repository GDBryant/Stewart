# Stewart

**A cross-IDE AI coding assistant — a shared TypeScript core with VS Code and JetBrains hosts, talking to Ollama, OpenAI-compatible providers (including AI Factory), or the Claude Code CLI.**

Stewart adds a chat panel to VS Code and a tool window to JetBrains IDEs. One lead agent per chat session reads, searches and edits project files, runs shell commands and attaches images — with configurable channels, agents, roles and skills. File edits and commands require approval unless covered by a grant.

[![CI](https://github.com/GDBryant/Stewart/actions/workflows/ci.yml/badge.svg)](https://github.com/GDBryant/Stewart/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-JetBrains%202026.1%2B%20%C2%B7%20VS%20Code-blue)

---

## Features

### Chat and models

- Chat UI (Preact webview shared by both hosts) with markdown replies, streaming, cancel, image attachments (picker/paste/drop), history, and a first-run **setup wizard**.
- Channels are configurable YAML instances, not hardcoded providers:
  - **Ollama** — local or remote; models listed live from `/api/tags`.
  - **OpenAI-compatible** — any endpoint (AI Factory, OpenRouter, LM Studio, …); API keys live in the IDE secret store.
  - **Claude CLI** — enterprise SSO via the `claude` binary; no API key stored in the IDE.
- Multiple **agents** bind a channel+model pair with price/billing and capability metadata; the model picker shows tested/green candidates.

### Run mode

- **Lead session** — one lead agent runs your message end to end in a persisted session: the `native-loop` engine (native tool calling) for ordinary channels, the `claude-code` engine (the Claude Code CLI as a supervised full agent in the project root) for `claude-cli` channels. Each turn ends with a code-run check (`@stewart/tasks`: failed writes, required files, exit code, empty reply) and the result is reported with the run.

### Tools

| Tool | What it does | Approval |
|------|--------------|----------|
| `ReadFile`, `FindFiles`, `Search`, `ListCodeFiles` | Read/inventory/search project files | automatic |
| `GetDiff`, `GetProblems`, `ReadImage` | Diffs, diagnostics, image reads | automatic |
| `WriteFile`, `EditFile`, `ApplyPatch` | Create/edit files | gated |
| `RunTerminal` | Shell commands in the project | gated |
| `GenerateImage` | Image generation where the channel supports it | gated |

File tools are confined to project roots (symlinks resolved); role `writePaths` further restrict writes. Tool calls are always native — there is no text shim.

### Approvals and permissions

Approval prompts offer three scopes: **once**, **this chat** (run grant), **always** (session grant). Command grants can be scoped to parsed program names; unparseable commands cannot receive program grants and always prompt unless a category-wide grant is active. Grants live in memory per run/session — they are not persisted to the repository.

### Checks and cost

- **Checks**: every turn carries a check code can run — failed writes, files that must exist, an optional command, a non-empty reply. `run.finished` reports `done` only when the check passed.
- **Cost**: usage meters into a per-project ledger; `costLimit.perRunUsd` aborts a turn past the cap.

### Setup wizard, health check, observability

- **Setup wizard**: channels → quick-probe discovery (green/orange/red per model) → evaluator-ranked assignment of agents/roles → review → staged apply with undo.
- **Health check**: ask for a repo health report; the `code-health-reviewer` role inventories files and submits structured reports (`submit_health`/`health_report` verbs).
- **Debug logging**: optional JSONL call log with redaction and retention (`settings.log`).

### Images

Attach images to chat (paste/drop/picker); providers that support vision receive them inline. `ReadImage`/`GenerateImage` tools expose image I/O to agents; vision/image-gen capabilities are gated per model.

## Configuration

Shared config lives in one directory for every IDE and project (`$STEWART_CONFIG_DIR` > `$XDG_CONFIG_HOME/stewart` > `%APPDATA%\stewart` > `~/.config/stewart`):

```
~/.config/stewart/
  channels.yaml   channel instances (type, baseUrl, modelCaps, secretRef)
  agents.yaml     agent defs (channel+model, price, billing, budget)
  roles.yaml      role defs (prompt, agent, tools, writePaths, turnBudget)
  settings.yaml   global settings (profiles, compaction, logging, …)
  skills/         SKILL.md skill bodies (shipped < user < project merge)
```

Per-project overrides: `.stewart/roles.yaml`, `.stewart/skills/` (trusted workspaces). Secrets are referenced by `secretRef` and stored in the IDE secret store — never in YAML.

## Repository layout

```
packages/
  protocol/    JSON-RPC types + capability negotiation
  core/        all logic; no host imports (handlers/, channels wiring, sessions)
  sidecar/     Node stdio JSON-RPC server for the JetBrains host
  webview/     Preact chat + settings + setup wizard (one bundle, both hosts)
modules/       17 @stewart/* packages in layers: kernel (ports/types), config,
               channels, tools, engines, session, tasks, permissions,
               roles-skills, context, models, ledger, interaction,
               diagnostics, catalog, code-health, setup
hosts/
  vscode/      VS Code extension (extension.ts, webview host, routes)
  jetbrains/   IntelliJ platform plugin (Kotlin): tool window, JCEF webview,
               HostPort impls, sidecar supervisor
docs/          ai_docs/ (living), health_reports/, archived_*/
scripts/       build-install.sh, ollama-local.sh, checks (layers/boundaries/cycles/tsrefs), tests
```

## Requirements

- **VS Code** `^1.145.0`, or a **JetBrains IDE 2026.1+** (since-build 261; verified on IntelliJ IDEA Community 2026.1 and PyCharm Professional 2026.2).
- **JDK 21** and Node to build from source; the JetBrains plugin bundles its own Node for the sidecar.
- At least one provider: Ollama running locally, an OpenAI-compatible endpoint + API key, or the `claude` CLI logged in.

### Local Ollama via Docker

`docker/ollama/` runs Ollama in Docker with the two smallest models (`qwen3.5:4b`, `gemma4:e4b`; larger ones are commented out in `docker/ollama/models.txt`). Then add an `ollama` channel at `http://localhost:11434`.

```bash
./scripts/ollama-local.sh up [cpu|gpu]   # start Ollama (GPU needs NVIDIA Container Toolkit)
./scripts/ollama-local.sh pull           # pull models from models.txt
./scripts/ollama-local.sh webui          # optional Open WebUI on :3000
./scripts/ollama-local.sh down
```

## Build, test, install

```bash
pnpm install
pnpm -r build          # all packages (sidecar + webview bundles included)
pnpm -r test           # vitest per package
pnpm -r typecheck
pnpm test:coverage     # per-package gate: >=90% lines, >=80% branches
pnpm check:layers      # module manifest layers + single "." export
pnpm check:boundaries  # core file-size limits
pnpm check:cycles      # dependency-cruiser
pnpm check:tsrefs      # tsconfig project references in sync
pnpm test:scripts      # node:test for scripts/*
```

If pnpm is unavailable, build per package: `cd modules/<name>` then `./node_modules/.bin/vitest run`, `./node_modules/.bin/tsc -p tsconfig.json --composite false --noEmit`, `./node_modules/.bin/tsc -p tsconfig.json`.

### Install

```bash
./scripts/build-install.sh                # build + install both hosts
./scripts/build-install.sh --skip-vscode  # JetBrains only
./scripts/build-install.sh --skip-jetbrains
./scripts/build-install.sh --bundle-node  # bundle Node into the JB zip
./scripts/build-install.sh --jetbrains-plugins-dir <path>
```

JetBrains only:

```bash
./gradlew buildPlugin   # zip in build/distributions/
./gradlew test          # Kotlin tests (koverVerify enforces the same 90/80 gate)
./gradlew runIde        # disposable IDE with the plugin
```

VS Code produces `hosts/vscode/stewart.vsix`; install via `code --install-extension` or the Extensions view. CI (`.github/workflows/ci.yml`) runs build/typecheck/test/coverage plus VSIX and Gradle packaging; releases are tag-driven (`release.yml`).

After changing any sidecar dependency, re-bundle the sidecar before Gradle packaging:

```bash
cd packages/sidecar && ./node_modules/.bin/tsc -p tsconfig.json && \
  ./node_modules/.bin/esbuild src/main.ts --bundle --format=cjs --platform=node --outfile=dist/sidecar.cjs
```

## Security model

Stewart is a coding agent, not a sandbox. Its protections:

- File tools validate paths against project roots, including resolved symlinks; role `writePaths` narrow writes further.
- Edits and commands require approval or a matching grant; reads and searches run automatically when tools are enabled.
- Program-based command grants require successful shell parsing; unparseable commands always prompt.
- Permission/parse errors fail closed to prompting; secrets stay in the IDE secret store and are redacted from logs.

Commands run with your user privileges and can reach outside the project or the network. Keep grants narrow, review previews, and use version control.

## Privacy and data handling

- **Local Ollama:** inference stays on your machine (unless the URL is remote).
- **Remote providers:** conversation content and tool results (including file contents) are sent to the configured endpoint. Check provider retention and organizational policy.
- **History/logs:** saved chats and optional debug logs may contain source code and prompts. Redaction is best-effort; review retention settings before sharing.
- **Credentials:** API keys go to the IDE secret store; Claude auth is handled by the CLI login.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Model list empty | Provider reachable? Ollama `ollama list` / correct base URL; re-test the channel in Settings. |
| Connection refused/timeout | Endpoint, port, proxy, firewall from the IDE's machine. |
| Claude login/executable error | `claude` on PATH or configured path; `auth status` works outside the IDE. |
| Model describes actions but doesn't call tools | Channel `modelCaps.tools` mode (native vs shim); pick a tool-capable model. |
| Commands skip approval unexpectedly | Approval cards show the grant scope chosen; grants are per-run/per-session only. |
| Plugin missing (JetBrains) | IDE ≥2026.1, install the zip from `build/distributions/`, restart. |

For bug reports include IDE/host version, provider/model, steps and sanitized errors — never raw credentials or unreviewed logs.

## Code health

Latest report: [`docs/health_reports/2026-11-09-code-health.md`](docs/health_reports/2026-11-09-code-health.md). All gates green: tests, typecheck, build, coverage (≥90/80 per package), layer/boundary/cycle/tsref checks. Complexity scan: 0 functions >15 branches, 8 >10.

## Documentation

| Doc | Contents |
|-----|----------|
| [`AGENTS.md`](AGENTS.md) | Contributor commands and conventions |
| [`docs/ai_docs/ARCHITECTURE_NOW.md`](docs/ai_docs/ARCHITECTURE_NOW.md) | Living as-built architecture (modules, run paths, config) |
| [`docs/ai_docs/PROGRESS.md`](docs/ai_docs/PROGRESS.md) | Milestone status |
| [`docs/ai_docs/SETUP.md`](docs/ai_docs/SETUP.md) | Setup wizard steps, probe queue, assignment |
| [`docs/ai_docs/PERMISSIONS.md`](docs/ai_docs/PERMISSIONS.md) | Approval categories, grants, shell parsing, storage |
| [`docs/ai_docs/IMAGES.md`](docs/ai_docs/IMAGES.md) | Image attachments, provider wire formats, vision gating |
| [`docs/ai_docs/DEBUG_LOGGING.md`](docs/ai_docs/DEBUG_LOGGING.md) | Log format, redaction, retention |
| [`docs/ai_docs/COMPATIBILITY.md`](docs/ai_docs/COMPATIBILITY.md) | Verified IDEs, pinned toolchain |
| [`docs/ai_docs/RELEASING.md`](docs/ai_docs/RELEASING.md) | VSIX/zip packaging, signing, release workflows |
| [`docs/health_reports/`](docs/health_reports/) | Dated code-health reports |
| `docs/archived_v1/`, `docs/archived_v2/` | Superseded plans, kept for history |

## Contributing

Issues and pull requests are welcome. Please:

- keep changes small and focused;
- add tests for both positive and negative behaviour — every change ships tests;
- keep `pnpm -r test`, `pnpm -r typecheck`, `pnpm test:coverage` and the `check:*` scripts green;
- update `docs/ai_docs/ARCHITECTURE_NOW.md` in the same change when modules, run paths, protocol, config or host wiring change.

## License

No license has been published for this repository yet. Until one is added, the default copyright applies — please open an issue if you would like to use the code.

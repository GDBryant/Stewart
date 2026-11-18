# Permissions

Per-project approval bypass for tools that ask before acting. See `docs/archived_v1/BYPASS_MODE_PLAN.md` for the build plan.

## Bypass mode

The chat bar (next to **New chat** and **History**) has a toggle labelled **Bypass is OFF** / **Bypass is ON** (red when on). When on, every tool call that would prompt is auto-approved:

- Core: `Permissions.setBypass(on)` (`modules/permissions/src/permissions.ts`); `decide()` returns `allow` before any grant check and records no grants. Covers lead, child (`delegate`) and task runs — all go through `permissions.gate` — and both engines (Claude Code `can_use_tool` and MCP host tools route through the same gate).
- Role policy still applies: `policyApprove` runs before the gate, so a read-only role still cannot write. Bypass skips prompts, not role limits.
- RPC `permissions.bypass {projectId, on?}` → `{on}` (omit `on` to query). Webview posts `permissions.bypass`, hosts reply `permissions.bypass.result`; the webview queries the state on ready.
- Turning it on also approves (`once`) any approval cards already waiting.
- Scope: per project, in memory in the core. Not persisted; it resets to OFF when the core (VS Code extension host / JetBrains sidecar) restarts.

## Categories

- `EDITS` — `WriteFile`, `EditFile` (previews `ToolPreview.FileChange`)
- `COMMANDS` — `RunTerminal` (previews `ToolPreview.Command`)
- `OTHER` — future approval tools that declare `ToolPreview.Other`; a null or unknown preview is never bypassed

## Effective rule

A tool call is auto-approved when any of these holds:

1. Its category is ticked in the project settings or granted "for this chat".
2. For `RunTerminal` only: the command splits cleanly (below) and every resulting program is granted, either always-in-project or for this chat.

Anything else prompts. Any error inside the permission check prompts instead of approving (fail closed).

## Grant granularity

A program grant covers **every** invocation of that program: any arguments, any `cwd` inside the project roots. Granting `git` also allows `git push --force`, `git clean -fdx` and malicious aliases. This is a deliberate scope choice, not a bug; there is no argument-scoped grant.

## Sub-command matching

`ShellCommandSplitter` splits the command on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes, then takes each segment's program token (on Windows `cmd /c`, splitting on `&` and `|`, case-insensitive, `.exe` ignored).

Not split into commands: `2>&1`, `>/dev/null`, `&>`, `|&` and quoted operators. Safe leading `VAR=value` assignments are stripped.

The command is unparseable (always prompts) when it contains:

- command/process substitution (`$()`, backticks, `<( )`), file redirections (`> out`), heredocs
- dangerous assignments (`PATH`, `LD_PRELOAD`, `IFS`, `BASH_ENV`, `ENV`, `CDPATH`, `SHELLOPTS`, `GLOBIGNORE`, `PYTHONPATH`, `NODE_OPTIONS`, `PERL5OPT`, ...)
- shells, interpreters, launchers and builtins that could re-enter the shell (`sh -c` variants, `python -c`, `xargs`, `find -exec`, `sudo`, `env`, `command`, `timeout`, `awk`, `sed`, `source`, `cd`, `export`, ...)
- grouping `()`, `{}`, negation `!`, comment-only or empty input, unbalanced quotes, a trailing `\`
- on Windows: `^`, `%VAR%`, `call`, `start`, `for`, `set`, `setx`, `()` grouping

## Scopes

- **Just once** — approve this call only.
- **Allow for this chat** — stored in `SessionGrants` (memory only); cleared with the conversation and never persisted.
- **Always allow in this project** — persisted in `ProjectPermissions` (app-level `stewart-permissions.xml`, `SettingsCategory.SYSTEM`, excluded from Settings Sync).

The command dialog offers two scopes: "These programs" (the ungranted programs of the parsed command; disabled when unparseable) and "All shell commands" (the `COMMANDS` category). File and generic dialogs grant their category (`EDITS` / `OTHER`).

## Revoke paths

- v2: the chat-bar **Bypass** toggle (off); chat grants clear with the run, session grants with the core.
- v1 (archived Kotlin plugin, kept for reference): Bypass popup, project settings page and `/permissions` commands.

## Migration

On first permissions read after upgrade, a single app-wide flag runs once: if the legacy `autoApproveEdits` was true, `EDITS` is ticked for the projects open at that moment. Nothing is seeded for projects opened later or moved (a new `locationHash` never re-seeds). The legacy field is never written again.

## Audit

Every auto-approved call writes a `DebugLogSink` record (`auto-approve`, tool name, category, detail) when debug logging is enabled, (v1; the v2 Bypass toggle shows no count).

## Storage

Application-level `stewart-permissions.xml` maps `project.locationHash` → path, ticks, programs. It lives in the IDE config dir but is `SettingsCategory.SYSTEM`, so Settings Sync and export skip it — a location hash is meaningless on another machine.

Legacy: on first load an old AIJB `aijb-permissions.xml` is migrated once into `stewart-permissions.xml` (old file kept); see `docs/archived_v1/RENAME_PLAN.md`.

## Scratch auto-approval

- `WriteFile` and `EditFile` strictly inside the current run's registered scratch task dir (`.stewart/scratch/<runId>/task-<m>-<t>/`) are auto-approved. Registration lasts from split start until the task finishes.
- Everything else, including `final_file`, uses normal approval. Bypass and grants apply as usual.
- Code: `ScratchApprovalGate` in `agents/Scratch.kt`. See `docs/archived_v2/FAULT_RECOVERY.md`.

# Permissions

Per-project approval bypass for tools that ask before acting. See `docs/BYPASS_MODE_PLAN.md` for the build plan.

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

- Bypass popup (chat header): uncheck a category, "Clear chat grants", "Manage…" opens the project page
- Project settings page (Settings → Stewart under project): ticks, program list, chat grants view, "Reset all projects"
- `/permissions` — list; `/permissions clear` — chat grants; `/permissions revoke <edits|commands|other|all|program>` — always + chat grants; `/permissions reset` — remove this project's entry

## Migration

On first permissions read after upgrade, a single app-wide flag runs once: if the legacy `autoApproveEdits` was true, `EDITS` is ticked for the projects open at that moment. Nothing is seeded for projects opened later or moved (a new `locationHash` never re-seeds). The legacy field is never written again.

## Audit

Every auto-approved call writes a `DebugLogSink` record (`auto-approve`, tool name, category, detail) when debug logging is enabled, and the session auto-approve count is shown in the Bypass button tooltip.

## Storage

Application-level `stewart-permissions.xml` maps `project.locationHash` → path, ticks, programs. It lives in the IDE config dir but is `SettingsCategory.SYSTEM`, so Settings Sync and export skip it — a location hash is meaningless on another machine.

Legacy: on first load an old AIJB `aijb-permissions.xml` is migrated once into `stewart-permissions.xml` (old file kept); see `docs/RENAME_PLAN.md`.

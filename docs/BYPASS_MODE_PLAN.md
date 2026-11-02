# Approval Bypass Mode — Plan

Status: **planned**. Adds per-category bypass ticks and "allow for this chat / always" grants to the
tool approval flow. Supersedes the sketch in `docs/PHASE2.md` item 5 (which proposed `alwaysAllow*`
flags in `AijbSettings.State`). Code today: `ui/ApprovalDialogs.kt` (`IdeApprovalGate`, dialogs),
`tools/ToolLoop.kt` (calls the gate), `tools/ProjectTools.kt` (`WriteFile`, `EditFile`, `RunTerminal`).

## Current behaviour

- Tools with `requiresApproval = true`: `WriteFile`, `EditFile` (preview `FileChange`) and
  `RunTerminal` (preview `Command`). No tool uses the generic dialog today (`AskUser` and the
  orchestrator's read-only tool set `requiresApproval = false`).
- One global setting, `autoApproveEdits` ("Trusted mode"), skips the file dialog. Commands always prompt.
- Dialogs offer only Approve / Reject. Nothing is remembered. They are modeless so Stop stays
  reachable; tools run serially, so at most one is open.
- `RunTerminal` runs `/bin/sh -c <command>` (`cmd /c` on Windows), so one call can chain many programs.
  The `cwd` argument is resolved through `ProjectPaths`, which rejects paths outside the project roots.

## Decisions

- **Categories:** `EDITS` (WriteFile, EditFile), `COMMANDS` (RunTerminal), `OTHER`.
  - `categoryOf(preview)`: `FileChange → EDITS`, `Command → COMMANDS`, `ToolPreview.Other → OTHER`,
    `null` or unknown → no category.
  - A tool that returns no preview (or an unrecognised one) is **never** bypassed: it always prompts.
    A future approval tool must return `ToolPreview.Other` to opt into the `OTHER` tick. This keeps
    `OTHER` from silently covering tools added later.
- **Ticks:** a "Bypass" toggle in the chat panel header, with one checkbox per category, **per
  project**. A ticked category never prompts and has no extra guards ("allow all shell commands"
  means every command, chained or not).
- **Session grants** ("Allow for this chat") last for the current conversation only. They live in
  memory on `ChatSession`. They are cleared by Clear, `/clear`, `/permissions clear`, and whenever
  the transcript is replaced by a restored or different conversation (so a future `/resume` cannot
  leak them). They are lost on IDE restart; restored history never restores grants.
- **Always grants** go to a **per-project** list.
  - "Always allow all edits/commands/other" turns that category's tick on, so there is one place to
    see it and revoke it.
  - The list itself holds program grants (e.g. `git`, `./gradlew`).
- **Command grants:** the dialog offers both scopes, *this program* and *all commands*. Each can be
  granted for this chat or always.
- **Grant granularity (explicit limitation):** a program grant covers **every argument list and
  every cwd** for that program. Granting `git` also allows `git push --force`, `git clean -fdx` and
  `git config alias.x '!rm -rf /'`. Granting a build tool (`gradlew`, `npm`, `cargo`, `make`) trusts
  the project's build files. The dialog and `docs/PERMISSIONS.md` say so. There is no
  argument-scoped grant in this version.
- **Sub-commands:** when `COMMANDS` is not ticked, a command is split into its sub-commands. It runs
  without a prompt only if the command is parseable, has at least one segment, and **every**
  segment's program is granted. Otherwise the user is prompted, and the dialog lists the ungranted
  programs. See work item 3.
- **Effective rule:** a call is approved without a prompt if
  - its category is ticked or covered by a chat category grant, or
  - it is a parseable, non-empty command whose every program is in the project always-list or the
    chat program grants.
  A revoke takes effect from the next call.
- **Fail closed:** any exception while reading permissions or splitting the command, corrupt or
  unreadable state, an empty command, or an unknown preview leads to a prompt, never to approval.
- **Storage:** bypass state must never come from the repo.
  - Ticks and the always-list are stored in **application-level** state, keyed by
    `project.locationHash`, with the project path kept for display. They are not kept in `.idea/`
    or any project file.
  - `roamingType = RoamingType.DISABLED`, so Settings Sync does not carry bypass state to another
    machine where the hash means nothing. The file is not part of "Export settings".
  - A cloned repo therefore cannot ship "bypass on".
  - Entries are not pruned automatically. A moved or renamed project gets a new hash and loses its
    grants (the legacy `autoApproveEdits` is **not** re-applied, see Migration). The settings page
    shows the stored path and offers "Reset all projects".
- **Threading:** state is written only on the EDT inside `modify { }`. The gate reads an immutable
  snapshot published through a `@Volatile` field, so it never sees a half-updated map and never
  touches the XML-serialised collections.
- **Audit:** every auto-approved call is written to the debug log when it is enabled (`DebugLogSink`,
  see `docs/DEBUG_LOGGING.md`) with the category, the tool and the command or path. The toggle
  tooltip shows how many calls were auto-approved in this chat.
- **Consent:** enabling `COMMANDS` or `OTHER` asks for confirmation (they disable every guard);
  enabling `EDITS` does not. While anything is active a dedicated label next to the input shows
  `bypass: edits, cmds` for the whole run, not just the button.
- **Migration:** the global `autoApproveEdits = true` seeds the `EDITS` tick **once, app-wide**. The
  legacy checkbox is removed from `AijbConfigurable`; the field stays in the state class for
  migration, is never written again, and is not consulted after the one-shot flag is set. Projects
  created later start with no ticks.
- **Views and revoke:** you can see and revoke grants in three places.
  - A project settings page.
  - A chat panel indicator, which is the toggle itself.
  - A `/permissions` slash command.

## Work items

1. **Permission model** (`tools/permissions/`)
   - `enum ApprovalCategory { EDITS, COMMANDS, OTHER }`, with
     `categoryOf(preview: ToolPreview?): ApprovalCategory?`.
   - Add `data object Other : ToolPreview` to `tools/Tools.kt`; the generic dialog renders it like
     today's null case. `AskUser` and read tools stay `requiresApproval = false`.
   - `ProjectPermissions` is an app-level service: `@Service(Service.Level.APP)` +
     `@State(name = "AijbPermissions", storages = [Storage("aijb-permissions.xml")],
     roamingType = RoamingType.DISABLED)`, extending `SimplePersistentStateComponent`. No
     `plugin.xml` service entry (same pattern as `AijbSettings`).
     - `State(migrated: Boolean, entries: MutableMap<String, Entry>)`;
       `Entry(path: String, ticks: MutableList<String>, programs: MutableList<String>)`. Category
       names are stored as strings so the XML survives enum renames.
     - `forProject(project)` returns a `Snapshot(ticks: Set<ApprovalCategory>, programs: Set<String>)`
       copied under the lock, and triggers the one-shot migration.
     - Mutators (`setTick`, `addProgram`, `removeProgram`, `revoke`, `resetProject`, `resetAll`) run
       on the EDT inside `modify { }` and publish a new snapshot.
     - `migrated` is a single app-wide flag, not per project.
   - `SessionGrants` holds the same shape (categories and programs) in memory on `ChatSession`.
     `clearHistory()` clears it; so does replacing the transcript with a restored conversation.
   - `PermissionsListener` is a `Topic` constant (same pattern as `AijbSettings.TOPIC`; no
     `plugin.xml` topic entry). `ChatPanel` subscribes with `messageBus.connect(this)`.
2. **Gate** (`IdeApprovalGate.review`)
   - The bypass check runs inside the gate, **after** ToolLoop has built the preview. The preview is
     never skipped: `RunTerminal.execute` needs it and the edit tools verify against it.
   - The `ApprovalGate` interface, ToolLoop and `ApprovalDecision` stay unchanged.
   - Constructor: `IdeApprovalGate(project, permissions: () -> Snapshot, grants: SessionGrants,
     prompter)`. Pass `SessionGrants`, not `ChatSession`, so there is no construction cycle.
   - Order:
     1. `categoryOf(preview)`; null → prompt.
     2. Category ticked or covered by a chat category grant → `Approved`.
     3. `COMMANDS` only: split; approve when parseable, non-empty, and every program is covered by
        the always-list or the chat grants.
     4. Otherwise prompt.
   - Wrap 1–3 in a fail-closed guard: any exception logs and falls through to the prompt.
   - Prompters return `PromptResult(decision, grant: Grant?)`, where
     `Grant(scope: CHAT | ALWAYS, target: Category | Programs(Set<String>))`. The gate records the
     grant on the EDT, then returns the decision. A rejected or cancelled prompt records nothing.
   - Log auto-approved calls to the debug log and bump the chat counter.
   - Replace the `autoApproveEdits` lambda with the permissions snapshot. Update `ChatSession.kt:84-85`.
   - Orchestrator sub-agents already receive the same gate instance (`Orchestrator.kt:267/540`), so
     grants also cover them. Add a test for this.
3. **Command parsing** (`ShellCommandSplitter`, pure function)
   - Signature: `split(command: String, windows: Boolean): SplitResult`, with
     `Parsed(programs: List<String>)` or `Unparseable(reason: String)`. The gate passes
     `SystemInfo.isWindows`; tests cover both branches on any host.
   - Order of work, so `2>&1` is not mistaken for `&`:
     1. Scan for unparseable constructs, quote-aware (see below).
     2. Split on `;`, `&&`, `||`, `|`, `&` and newline, outside single or double quotes.
        A `&` that is part of `>&`, `&>` or `|&` is a redirection, not a separator.
     3. Strip leading `VAR=value` assignments; the program is the next token.
   - Quotes and escapes: `\` escapes the next character outside single quotes and inside double
     quotes; a `\` at end of line (continuation) makes the command unparseable. `$'…'` is
     unparseable.
   - Unparseable constructs (outside single quotes; inside single quotes they are literal):
     `$(…)`, backticks, `<(…)`, `>(…)`, unbalanced quotes, and redirection to a file (`>`, `>>`,
     `<` except `/dev/null` and `&N`).
   - Unparseable programs (a grant cannot cover what they launch):
     - shells: `sh`, `bash`, `dash`, `zsh`, `ksh`, `fish`, `busybox`, including `-c`, `-ec`, `-lc`
       and `/bin/sh`-style paths;
     - interpreters: `python*`, `pypy*`, `perl`, `ruby`, `node`, `deno`, `bun`, `php`, `lua`,
       `Rscript`, `pwsh`, `powershell`, `osascript`;
     - launchers and text tools that execute: `xargs`, `find` with `-exec`/`-execdir`/`-ok`/
       `-okdir`/`-delete`, `sudo`, `doas`, `su`, `runuser`, `env`, `command`, `builtin`, `exec`,
       `eval`, `time`, `timeout`, `nice`, `nohup`, `stdbuf`, `setsid`, `chroot`, `watch`, `script`,
       `source`, `.`, `awk`, `sed`;
     - shell-state and directory builtins: `export`, `unset`, `set`, `alias`, `unalias`, `typeset`,
       `declare`, `readonly`, `hash`, `ulimit`, `trap`, `cd`, `pushd`, `popd`.
     - A segment that is only assignments, or starts with `(`, `{` or `!`, is unparseable.
   - Unparseable assignments: `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `IFS`, `BASH_ENV`, `ENV`,
     `CDPATH`, `SHELLOPTS`, `GLOBIGNORE`, `PYTHONPATH`, `NODE_OPTIONS`, `PERL5OPT`. Other leading
     assignments are stripped. (Stripping alone would let `PATH=/tmp git status` run `/tmp/git`.)
   - Program token: unquote a fully quoted token, keep the path verbatim otherwise. On Windows,
     match case-insensitively and ignore a trailing `.exe`.
   - An empty result (`""`, whitespace, comments only) is unparseable; it must never be vacuously
     "covered".
   - Windows (`cmd /c`): also split on `&` and `|`, and treat `^`, `%…%`, `call`, `start`,
     `for … do`, `set`/`setx` and `( )` grouping as unparseable.
   - Covered: every segment's program is granted and the command is not unparseable.
4. **Dialogs**
   - The approval dialog keeps Approve and Reject.
   - Next to Approve it adds a **"Remember"** dropdown:
     - Just once (default)
     - Allow for this chat
     - Always allow in this project
   - The command dialog adds a **scope** dropdown:
     - "These programs: `git`, `grep`". These are the ungranted programs from item 3.
     - All shell commands.
   - In the command dialog, ungranted sub-commands are highlighted and already-granted ones are
     shown dimmed. Unparseable commands show the reason and disable "These programs".
   - The file and generic dialogs use the category scope only ("all file edits", "all other tools").
   - "Always" combined with a category sets the tick; "this chat" combined with a category sets the
     session category grant.
   - The program scope shows the granularity caveat: "covers every `git` command, with any
     arguments, in this project".
   - Expose the selections through internal properties (`rememberChoice`, `scopeChoice`) so tests can
     drive the mapping without a real window.
5. **Chat panel toggle and indicator** (`ChatPanel`)
   - A "Bypass" header button opens a popup with three checkboxes (Edits, Commands, Other), plus
     two actions:
     - "Clear chat grants"
     - "Manage…", which opens the project settings page
   - Enabling Commands or Other asks for confirmation; the text says the setting is per project and
     disables every guard for that category.
   - When anything is active, the button label shows it, for example `Bypass: edits, cmds +3`
     (ticks and chat grants), and a dedicated label next to the input shows
     `bypass: edits, cmds` while active. Do not reuse `statusLabel`, which carries run messages.
   - The label refreshes through `PermissionsListener`; the tooltip shows the auto-approved count.
6. **Project settings page**
   - `AijbConfigurable` is an `applicationConfigurable`, so a project page cannot be its child.
     Register a separate top-level page instead:
     `projectConfigurable instance="...PermissionsConfigurable"
     id="com.aijb.assistant.settings.permissions" displayName="AIJB Assistant"`.
     "Manage…" opens it with `ShowSettingsUtil.showSettingsDialog(project, PermissionsConfigurable::class.java)`.
   - The page shows:
     - the three ticks
     - an editable list of always-allowed programs (one per line, Add / Remove; paths with spaces
       are allowed)
     - the stored project path
     - a read-only list of this chat's grants, with a Clear button
     - "Reset all projects" (confirmation)
   - Remove the "Trusted mode" checkbox from `AijbConfigurable`: the field, the three reads/writes
     (`isModified`, `reset`, `apply`) and the `AijbConfigurableTest` assertion.
7. **`/permissions` slash command** (allowed while running)
   - `/permissions` lists the ticks, the always programs, the stored path and the chat grants.
   - `/permissions clear` clears the chat grants.
   - `/permissions revoke <program|edits|commands|other>` removes an always grant, the tick and the
     matching chat grant. The program argument is the rest of the line, verbatim.
   - `/permissions revoke all` clears this project's entry. `all` is reserved.
   - `/permissions reset` removes this project's entry.
   - Unknown arguments print the usage.
   - Extend `CommandContext` with a `permissions: PermissionsView` accessor (list, clear, revoke,
     reset), implemented by `ChatPanel`; update the fake context in tests.
   - Clearing grants mid-run affects the next call in the same turn; say so in the command output.
8. **Migration**
   - On the first permissions read after upgrade, if the app-wide `migrated` flag is false:
     - set `migrated = true` in the same `modify { }`;
     - if the legacy `autoApproveEdits` is true, add `EDITS` to every currently open project
       (`ProjectManager.getInstance().openProjects`).
   - Nothing is seeded when no project is open, and nothing is seeded for projects opened later.
   - A moved project keeps `migrated = true`, so a revoke is never undone.
   - The legacy field is never written again.
9. **Docs**
   - Add `docs/PERMISSIONS.md`: categories, effective rule, grant granularity, how sub-commands are
     matched, unparseable constructs and programs, scopes, storage location, sync exclusion, revoke
     paths, migration.
   - Update `docs/PHASE2.md` item 5 to point at this plan, reference the new doc in `AGENTS.md`,
     update `docs/PROGRESS.md`, and mark this plan as done.

## Tests

Each item needs positive and negative cases. Existing seams that must be updated, not just added
to: `ApprovalGateTest` (`RecordingPrompter`, `Harness`, the `IdeApprovalGate(project, { … }, …)`
calls), `ChatSessionTest`, `ToolsProviderMatrixTest`, `OrchestratorTest`, `ToolLoopTest`, the
`ToolsE2E`/provider E2E tests, `AijbConfigurableTest` and the fake `CommandContext`.

- **`ShellCommandSplitter`**
  - Splitting:
    - `a && b | c; d &` gives `[a, b, c, d]`.
    - `FOO=1 git status` gives `git`.
    - Quoted operators such as `echo "a && b"` don't split.
    - `2>&1`, `>/dev/null`, `&>` and `|&` are not split into separate segments.
  - Unparseable inputs: `$(x)`, backticks, `<(x)`, `> out.txt`, unbalanced quotes, `sh -c`,
    `bash -lc`, `eval`, `exec`, `xargs`, `find . -exec`, `sudo`, `env`, `command`, `timeout`,
    `cd /`, `export PATH=/tmp`, `PATH=/tmp git status`, `python -c`, `awk`, `sed`, `$'x'`,
    a trailing `\`, an empty command, a comment-only command, `( git status )`.
  - Inputs that stay parseable: `git status`, `./gradlew test`, `grep -r x src`, `2>&1`,
    `>/dev/null`, `FOO=1 git status`.
  - Windows splitting, `^`, `%VAR%`, `call`, `start`, `for … do`, `( )`.
  - Case-insensitive and `.exe` matching on Windows; verbatim `./gradlew` vs `gradlew` elsewhere.
- **`IdeApprovalGate`**
  - A ticked category approves with no prompter call. One test per category.
  - An unticked category prompts.
  - A chat grant for a program covers a later `git log`.
  - A chat category grant covers a later command.
  - `git log && rm x` prompts, and only `rm` is listed as ungranted.
  - An unparseable command prompts even when every program is granted.
  - An empty command prompts.
  - It does not prompt when `COMMANDS` is ticked.
  - An always grant persists across `ChatSession` instances.
  - A chat grant does not survive `clearHistory()`.
  - A rejected prompt records no grant.
  - Choosing "Remember" with Reject records nothing.
  - A `null` preview prompts even with `OTHER` ticked; a `ToolPreview.Other` preview is covered by it.
  - A gate whose permissions snapshot throws prompts and logs.
  - An auto-approved call writes the debug-log record when debug logging is on.
- **`ProjectPermissions`**
  - Projects are isolated by `locationHash`.
  - XML round trip, including enum names stored as strings.
  - A planted `.idea/aijb*.xml` file in the project dir does not enable bypass (negative).
  - Concurrent read and write do not throw and the reader sees a consistent snapshot.
  - A moved project (new hash) starts empty and does not re-seed `EDITS`.
  - `resetProject` and `resetAll` clear only what they should.
- **Migration**
  - Global `true` seeds `EDITS` for open projects once. After a revoke it is not re-seeded.
  - Global `false` seeds nothing.
  - A project opened after migration gets nothing.
  - No open project: the flag is still set and nothing is seeded.
- **Orchestrator:** a grant made at one level covers the same program at another level.
- **Dialogs**
  - The dropdowns map to the correct `Grant`.
  - The program option is disabled for an unparseable command and the reason is shown.
  - Ungranted programs are listed and already-granted ones are dimmed.
  - The granularity caveat is present.
- **`ChatPanel`**
  - The toggle writes the ticks.
  - The label reflects the state; the separate bypass label is shown and cleared.
  - Enabling Commands/Other asks for confirmation; cancelling leaves the tick off.
  - "Clear chat grants" works.
- **Settings**
  - The project configurable round-trips the ticks and programs.
  - It rejects a blank program but accepts one with spaces.
  - "Reset all projects" clears every entry after confirmation.
  - The Trusted checkbox and its state reads are gone.
- **`/permissions`:** list, clear, revoke of a known entry and of an unknown entry, `revoke all`,
  `reset`, rest-of-line program with spaces, usage text, and the mid-run note.

## Acceptance

- `./gradlew test`, `./gradlew koverVerify` and `./gradlew buildPlugin` pass.
- Manual checks in `runIde`:
  - Approve `git status` with "Allow for this chat", choosing "These programs". `git log` then
    runs with no prompt; `git push --force` also runs (documented granularity).
  - `git log && ls` prompts and lists `ls` only.
  - `PATH=/tmp git status`, `xargs rm`, `cd / && rm -rf x`, `echo $(date)` and an empty command all
    prompt even with `git`, `rm` and `echo` granted.
  - Clear makes `git status` prompt again.
  - Tick Commands (confirm the warning), and `rm -f /tmp/x; echo $(date)` runs with no prompt.
    The bypass label is visible next to the input.
  - Choose "Always" with "all file edits": the Edits tick is on and it survives an IDE restart.
    In another project, edits still prompt.
  - Revoke Edits, move the project directory, reopen it: Edits stays off.
  - Debug logging on: the auto-approved calls appear in the log.
  - `aijb-permissions.xml` is not carried by Settings Sync (check the sync log on a second IDE).

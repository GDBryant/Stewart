# Approval Bypass Mode — Plan

Status: **planned**. Adds per-category bypass ticks and "allow for this chat / always" grants to the
tool approval flow. Code today: `ui/ApprovalDialogs.kt` (`IdeApprovalGate`, dialogs),
`tools/ToolLoop.kt` (calls the gate), `tools/ProjectTools.kt` (`WriteFile`, `EditFile`, `RunTerminal`).

## Current behaviour

- Tools with `requiresApproval = true`: `WriteFile`, `EditFile` (preview `FileChange`) and
  `RunTerminal` (preview `Command`). Any other approval tool would get the generic dialog.
- One global setting, `autoApproveEdits` ("Trusted mode"), skips the file dialog. Commands always prompt.
- Dialogs offer only Approve / Reject. Nothing is remembered.
- `RunTerminal` runs `/bin/sh -c <command>` (`cmd /c` on Windows), so one call can chain many programs.

## Decisions

- **Categories:** `EDITS` (WriteFile, EditFile), `COMMANDS` (RunTerminal), `OTHER` (any other
  approval tool, i.e. no or unknown preview).
- **Ticks:** a "Bypass" toggle in the chat panel toolbar, with one checkbox per category, **per
  project**. A ticked category never prompts and has no extra guards ("allow all shell commands"
  means every command, chained or not).
- **Session grants** ("Allow for this chat") last for the current chat only. They live in memory on
  the `ChatSession` project service. They are cleared by Clear and `/clear`, and they are lost on
  IDE restart. Restored chat history never restores grants.
- **Always grants** go to a **per-project** list.
  - "Always allow all edits/commands/other" turns that category's tick on, so there is one place to
    see it and revoke it.
  - The list itself holds program grants (e.g. `git`, `./gradlew`).
- **Command grants:** the dialog offers both scopes, *this program* and *all commands*. Each can be
  granted for this chat or always.
- **Sub-commands:** when `COMMANDS` is not ticked, a command is split into its sub-commands. It runs
  without a prompt only if **every** sub-command's program is granted. Otherwise the user is
  prompted, and the dialog lists the ungranted programs. See work item 3.
- **Effective rule:** a call is approved without a prompt if its category is ticked, or if every
  program in it is in the project always-list or the chat grants. A revoke takes effect from the
  next call.
- **Storage:** bypass state must never come from the repo.
  - Ticks and the always-list are stored in **application-level** state, keyed by
    `project.locationHash`. They are not kept in `.idea/` or any project file.
  - A cloned repo therefore cannot ship "bypass on".
- **Migration:** the global `autoApproveEdits = true` seeds the `EDITS` tick once for each project
  (a per-project `migrated` flag). The old checkbox is then removed. The field stays read-only for
  migration and is never written again.
- **Views and revoke:** you can see and revoke grants in three places.
  - A project settings page.
  - A chat panel indicator, which is the toggle itself.
  - A `/permissions` slash command.

## Work items

1. **Permission model** (`tools/permissions/`)
   - `enum ApprovalCategory { EDITS, COMMANDS, OTHER }`, with `categoryOf(preview)`.
   - `ProjectPermissions` is an app-level `PersistentStateComponent`, storing
     `Map<locationHash, Entry(ticks: Set<Category>, programs: Set<String>, migrated: Boolean)>`.
     - `forProject(project)` returns a view of that project's entry.
     - It uses concurrent collections, because the gate reads it off the EDT while the UI writes
       it on the EDT.
   - `SessionGrants` holds the same shape (categories and programs) in memory on `ChatSession`.
     `clearHistory()` clears it.
2. **Gate** (`IdeApprovalGate.review`)
   - The bypass check runs inside the gate, **after** ToolLoop has built the preview. The preview is
     never skipped: `RunTerminal.execute` needs it and the edit tools verify against it.
   - The `ApprovalGate` interface, ToolLoop and `ApprovalDecision` stay unchanged.
   - Order:
     1. Category ticked → `Approved`.
     2. Session or always grants cover the call → `Approved`.
     3. Otherwise prompt.
   - Prompters return `PromptResult(decision, grant: Grant?)`, where
     `Grant(scope: CHAT | ALWAYS, target: Category | Programs(Set<String>))`. The gate records the
     grant, then returns the decision.
   - Replace the `autoApproveEdits` lambda with the permissions view. Update `ChatSession.kt:84-85`.
   - Orchestrator sub-agents already receive the same gate instance (`Orchestrator.kt:267/540`), so
     grants also cover them. Add a test for this.
3. **Command parsing** (`ShellCommandSplitter`, pure function)
   - Split on `;`, `&&`, `||`, `|`, `&` and newline, outside single or double quotes.
   - Each segment's program is its first token after leading `VAR=value` assignments. Keep it
     verbatim, so `./gradlew` and `gradle` differ.
   - Some constructs can't be covered by a program grant: `$(…)`, backticks, `<(…)` and `>(…)`,
     unbalanced quotes, `eval`, `exec`, `sh -c`, `bash -c`, and redirection to a file (`>`, `>>`,
     `<` except `/dev/null` and `&N`).
     - A command that contains one of these is marked *unparseable*. It always prompts unless
       `COMMANDS` is ticked.
     - The "this program" option is disabled for it.
   - Windows (`cmd /c`): also split on `&` and `|`, and treat `^` and `%…%` as unparseable.
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
     shown dimmed.
   - The file and generic dialogs use the category scope only ("all file edits", "all other tools").
   - "Always" combined with a category sets the tick.
5. **Chat panel toggle and indicator** (`ChatPanel`)
   - A "Bypass" toolbar button opens a popup with three checkboxes (Edits, Commands, Other), plus
     two actions:
     - "Clear chat grants"
     - "Manage…", which opens the project settings page
   - When anything is active, the button label shows it, for example `Bypass: edits, cmds +3`.
   - The label refreshes through a `PermissionsListener` topic.
6. **Project settings page**
   - Add a `projectConfigurable` child named "AIJB Assistant → Permissions", with:
     - the three ticks
     - an editable list of always-allowed programs (Add / Remove)
     - a read-only list of this chat's grants, with a Clear button
   - Remove the "Trusted mode" checkbox from `AijbConfigurable`.
7. **`/permissions` slash command** (allowed while running)
   - `/permissions` lists the ticks, the always programs and the chat grants.
   - `/permissions clear` clears the chat grants.
   - `/permissions revoke <program|edits|commands|other>` removes an always grant or a tick.
   - Unknown arguments print the usage.
8. **Migration**
   - On the first `forProject` call: if the entry has `!migrated` and the global
     `autoApproveEdits` is true, add `EDITS`.
   - Set `migrated = true` whatever the global value was.

## Tests

Each item needs positive and negative cases.

- **`ShellCommandSplitter`**
  - Splitting:
    - `a && b | c; d &` gives `[a, b, c, d]`.
    - `FOO=1 git status` gives `git`.
    - Quoted operators such as `echo "a && b"` don't split.
  - Unparseable inputs: `$(x)`, backticks, `<(x)`, `> out.txt`, unbalanced quotes, `sh -c`,
    `eval`.
  - Inputs that stay parseable: `2>&1` and `>/dev/null`.
  - Windows splitting, `^` and `%VAR%`.
- **`IdeApprovalGate`**
  - A ticked category approves with no prompter call. One test per category.
  - An unticked category prompts.
  - A chat grant for a program covers a later `git log`.
  - `git log && rm x` prompts, and only `rm` is listed as ungranted.
  - An unparseable command prompts even when every program is granted.
  - It does not prompt when `COMMANDS` is ticked.
  - An always grant persists across `ChatSession` instances.
  - A chat grant does not survive `clearHistory()`.
  - A rejected prompt records no grant.
  - Choosing "Remember" with Reject records nothing.
  - An `OTHER` grant uses a fake tool that has no preview.
- **`ProjectPermissions`**
  - Projects are isolated by `locationHash`.
  - XML round trip.
  - A planted `.idea/aijb*.xml` file in the project dir does not enable bypass (negative).
  - Concurrent read and write do not throw.
- **Migration**
  - Global `true` seeds `EDITS` once. After a revoke it is not re-seeded.
  - Global `false` seeds nothing.
- **Orchestrator:** a grant made at one level covers the same program at another level.
- **Dialogs**
  - The dropdowns map to the correct `Grant`.
  - The program option is disabled for an unparseable command.
  - Ungranted programs are listed.
- **`ChatPanel`**
  - The toggle writes the ticks.
  - The label reflects the state.
  - "Clear chat grants" works.
- **Settings**
  - The project configurable round-trips the ticks and programs.
  - It rejects a blank program or one containing whitespace.
  - The Trusted checkbox is gone.
- **`/permissions`:** list, clear, revoke of a known entry and of an unknown entry, and usage text.

## Docs

- Add a new `docs/PERMISSIONS.md`. It should describe the categories, the effective rule, how
  sub-commands are matched, which constructs are unparseable, scopes, storage location and revoke
  paths.
- Reference it in AGENTS.md, update `docs/PROGRESS.md`, and mark this plan as done.

## Acceptance

- `./gradlew test`, `./gradlew koverVerify` and `./gradlew buildPlugin` pass.
- Manual checks in `runIde`:
  - Approve `git status` with "Allow for this chat", choosing "These programs". `git log` then
    runs with no prompt.
  - `git log && ls` prompts and lists `ls` only.
  - Clear makes `git status` prompt again.
  - Tick Commands, and `rm -f /tmp/x; echo $(date)` runs with no prompt.
  - Choose "Always" with "all file edits": the Edits tick is on and it survives an IDE restart.
    In another project, edits still prompt.

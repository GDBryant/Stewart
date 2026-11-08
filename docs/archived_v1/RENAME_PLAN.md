# Rename plan: AIJB Assistant → Stewart

Status: implemented on branch rename-stewart. Repo dir and GitHub remote (`GDBryant/Stewart`) are already named Stewart.

## Name mapping

| Kind | Old | New |
|---|---|---|
| Project title (AGENTS.md) | `AI_Jetbrains_Plugin` | `Stewart` |
| Gradle `rootProject.name` / zip | `aijb-assistant` → `aijb-assistant-<ver>.zip` | `stewart` → `stewart-<ver>.zip` |
| Gradle `group`, plugin `<id>` | `com.aijb.assistant` | `com.adb.stewart` |
| Version | `0.1.0` | `0.2.0` (new plugin id) |
| Kotlin/Java package | `com.aijb.assistant.*` | `com.adb.stewart.*` |
| Display name (plugin, tool window, configurables) | `AIJB Assistant` | `Stewart` |
| Vendor | `AIJB` | `ADB` |
| Classes | `AijbSettings`, `AijbSettingsListener`, `AijbConfigurable` (+ tests) | `StewartSettings`, `StewartSettingsListener`, `StewartConfigurable` |
| Dialog titles | `AIJB Permissions` | `Stewart Permissions` |
| App settings `@State` | `AijbAssistantSettings` / `aijb-assistant.xml` | `StewartSettings` / `stewart.xml` |
| Project perms `@State` | `AijbPermissions` / `aijb-permissions.xml` | `StewartPermissions` / `stewart-permissions.xml` |
| Password Safe service | `generateServiceName("AIJB Assistant", "AIF API key")` | `generateServiceName("Stewart", "AIF API key")` |
| History dir | `<system>/aijb-assistant/history/` | `<system>/stewart/history/` |
| Debug lock file | `.aijb-debug.lock` | `.stewart-debug.lock` |
| Thread names / log text | `AIJB-DebugLogSink-*`, `AIJB debug log …` | `Stewart-DebugLogSink-*`, `Stewart debug log …` |
| Temp prefixes (main + tests) | `aijb-claude-`, `aijb-out-`, `aijb-aif-debug*`, `aijb-live-iso-`, `/tmp/aijb*` | `stewart-…` |
| Busy icon id | `AsyncProcessIcon("aijb-busy")` | `AsyncProcessIcon("stewart-busy")` |
| Undo command name | `"AIJB: edit ${fileName}"` | `"Stewart: edit ${fileName}"` |
| CI artifact | `aijb-assistant-plugin` | `stewart-plugin` |

## Compatibility risks

Changing the plugin id makes this a **new plugin** to the IDE; persisted names change too. Without migration, existing installs lose:

1. **App settings** (`aijb-assistant.xml`) — models, roles, tool paths, debug settings.
2. **Project permissions** (`$CONFIG/options/aijb-permissions.xml`; `ProjectPermissions` is an app-level service with `SettingsCategory.SYSTEM`, not per-project `.idea`) — "always" grants per project.
3. **AIF API key** in Password Safe (service name changes).
4. **Chat history** (`<system>/aijb-assistant/history`).
5. Old plugin stays installed alongside the new one (`scripts/install-plugin.sh` unzips into a dir named from the zip root).

Decided: one-shot migration on first load (users are internal, few installs):
- `StewartSettings`/`StewartPermissions`: if new state is default and old XML file exists, read it via `XmlSerializer` into `State` and save; leave old file in place. "Default" check = `state.modificationCount == 0` (fall back to JDOM-compare against a fresh `State`) before any `loadState` writes. Permissions migration must preserve the existing one-shot `migrated` flag from the old file so the earlier bypass-mode seeding is not re-enabled.
- API key: if new credential empty, read old `CredentialAttributes`, write new, keep old.
- History: if new dir missing and old dir exists, copy (don't move).
- Each migration gets positive + negative tests (old present / old absent / new already set).

## Steps (one commit each, `./gradlew test koverVerify verifyPlugin` green after each)

1. **Package move** — `git mv src/{main,test}/kotlin/com/aijb/assistant src/{main,test}/kotlin/com/adb/stewart` (and `src/main/java/...`); `sed -i 's/com\.aijb\.assistant/com.adb.stewart/g'` over `src`, `build.gradle.kts`, `plugin.xml`. Pure refactor.
2. **Class renames** — `Aijb*` → `Stewart*` (files via `git mv`, identifiers via sed `\bAijb` → `Stewart`), excluding the `@State`/storage strings handled in step 3.
3. **Persisted keys + migration** — new `@State` names/storage files, credential service, history dir, lock file; add migration code + tests (see above).
4. **User-visible strings** — `plugin.xml` name/vendor/tool-window id/displayName, `build.gradle.kts` `pluginConfiguration` + `version = "0.2.0"`, `ErrorHints` ("Settings → Tools → Stewart"), dialog titles, thread names, log messages, undo command name `"Stewart: edit …"`, test `doRegisterToolWindow("Stewart")`.
5. **Build/CI/scripts** — `settings.gradle.kts` `rootProject.name = "stewart"`, `.github/workflows/build.yml` artifact name; `scripts/install-plugin.sh`: remove a stale `aijb-assistant` plugin dir when installing.
6. **Temp prefixes** — `aijb-*` → `stewart-*` in main and tests, plus the `aijb-busy` icon id.
7. **Docs** — AGENTS.md title + zip path; `docs/*.md` and `docs/superpowers/plans/*` references (`AIJB`, `aijb-assistant`, `com.aijb`, file paths); ../ai_docs/PROGRESS.md entry. Historical commit hashes stay as-is.
8. **Local env (not committed)** — uninstall old plugin from IDEs; delete gitignored `bin/` (stale Eclipse/VS Code Java build output with the old `com/aijb/assistant` tree; regenerates under the new package if that tooling is used again); delete stale `.idea/AI_Jetbrains_Plugin.iml` in this repo (step 5's `rootProject.name` change regenerates `stewart.iml`; let the IDE re-sync `modules.xml`); Claude memory dir `~/.claude/projects/-media-gdb-Data-Projects-AI-Jetbrains-Plugin` is stale (project already lives at `.../Stewart`).

## Verification

- `git ls-files -co --exclude-standard | xargs grep -Iil -E 'aijb|ai_jetbrains|ai-jetbrains'` (tracked + untracked, skips gitignored `bin/`, `.idea/`, `.intellijPlatform/`, `.kotlin/`, `.gradle/`, `build/`) lists only this plan and migration code/tests that reference old keys. Baseline before step 1: 119 files.
- `./gradlew clean buildPlugin test koverVerify verifyPlugin` pass; zip is `build/distributions/stewart-0.2.0.zip`.
- Manual: install over an IDE with the old plugin configured → settings, permissions, API key, history all present under Stewart; tool window titled "Stewart"; Settings → Tools → Stewart.

## Decisions

- Package root / plugin id: `com.adb.stewart`.
- Vendor: `ADB`.
- Migrate old data (settings, permissions, API key, history).
- Bump version to `0.2.0` (step 4, `build.gradle.kts`).

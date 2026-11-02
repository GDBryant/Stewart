# Debug Logging

Opt-in record of every model call, for diagnosing provider and prompt problems without a debugger.
Implemented by `com.adb.stewart.debug.DebugLogSink`.

## Enabling

Settings → Tools → Stewart (settings stored in `stewart.xml`; old AIJB settings are migrated on first load, see `docs/RENAME_PLAN.md`):

- **Debug log: record every model call (Ollama, AIF, Claude CLI)** — master switch, off by default.
- **Debug log folder** — defaults to `./log/debug_logs/`. Relative paths resolve under the IDE log
  directory (`PathManager.getLogPath()`), so the default lands in `<IDE log>/log/debug_logs/`.
  Absolute paths are used as-is.

Saved settings apply immediately; opening the chat panel also applies them at startup.

## Format

One line per event, appended to a UTC-daily file (`yyyy-MM-dd.log`):

```
[<ISO-8601 timestamp>] [<direction>] [<provider>] [<model>] [<payload>]
```

Directions: `outgoing` (request payload / Claude stdin), `incoming` (response chunk),
`stderr` (Claude CLI stderr), `error` (HTTP error body, connection failure, incomplete stream).

Payloads are single-line: `\`, CR, LF and TAB are escaped.

## Redaction

Before writing, `Authorization` header values, standalone `Bearer <token>` values and the stored
AIF API key are replaced with `[REDACTED]`. Prompt and response text is otherwise logged verbatim —
treat the files as sensitive.

## Files and retention

- Written on a single background thread (`Stewart-DebugLogSink-Writer`) through a reused buffered
  writer, flushed per line; the IDE/EDT thread is never touched.
- The target folder is resolved when a line is queued, so changing the setting cannot split one
  call across folders.
- New files are created owner-only (`rw-------`) where the filesystem supports POSIX permissions.
- Retention (setting "Debug log retention", 0–365 days, default 7; invalid values are rejected):
  `N > 0` keeps today plus the previous `N` days; `0` never prunes. Pruning runs when logging is
  enabled via settings or panel init (no model traffic needed) and when a new daily file opens.
- Only files the sink wrote are deleted: the first line must match the sink's line format.
  Foreign or unreadable files are kept.
- Rotation: a file reaching 50 MB (soft cap) is renamed to the first free `yyyy-MM-dd.N.log`
  (`.1` oldest, base file newest; order numerically). Rotation happens only while holding the
  exclusive lock on `<folder>/.stewart-debug.lock`; if another IDE instance holds it, the sink keeps
  appending. A writer whose file was renamed away reopens a fresh base file. A day's chunks are
  pruned together.
- A shutdown hook flushes and closes the open file.
- The first write failure and the first prune failure are each reported to the IDE log once; later ones are ignored. Logging never
  throws and never breaks a model call.

## Coverage

Logged: Ollama `/api/chat` (request, chunks, HTTP errors, connection failures, incomplete stream),
AIF `chat/completions` (same), Claude CLI (stdin, every stdout line, stderr, start failures).

Not logged: `listModels` endpoints, Claude `auth status`, the Claude system prompt file, and
tool-loop/orchestration events (the underlying provider traffic is logged).

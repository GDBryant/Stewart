# Debug Logging

Opt-in record of every model call, for diagnosing provider and prompt problems without a debugger.
Implemented by `com.aijb.assistant.debug.DebugLogSink`.

## Enabling

Settings → Tools → AIJB Assistant:

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

- Written on a single background thread (`AIJB-DebugLogSink-Writer`) through a reused buffered
  writer, flushed per line; the IDE/EDT thread is never touched.
- The target folder is resolved when a line is queued, so changing the setting cannot split one
  call across folders.
- New files are created owner-only (`rw-------`) where the filesystem supports POSIX permissions.
- Retention: when a new daily file is opened, files dated before `today - RETENTION_DAYS` (7) are
  deleted, so today's file plus the previous 7 days are kept (8 files). Files not named
  `yyyy-MM-dd.log` are left alone.
- Known gaps: pruning only runs when a new file is opened; any `yyyy-MM-dd.log` in the folder is
  deleted when stale, even one the sink did not write; there is no per-file size cap; prune
  failures are not reported. Fixes are planned in `docs/DEBUG_RETENTION_PLAN.md`.
- A shutdown hook flushes and closes the open file.
- The first I/O failure is reported to the IDE log once; later failures are ignored. Logging never
  throws and never breaks a model call.

## Coverage

Logged: Ollama `/api/chat` (request, chunks, HTTP errors, connection failures, incomplete stream),
AIF `chat/completions` (same), Claude CLI (stdin, every stdout line, stderr, start failures).

Not logged: `listModels` endpoints, Claude `auth status`, the Claude system prompt file, and
tool-loop/orchestration events (the underlying provider traffic is logged).

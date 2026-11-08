# Debug Logging

## v2 (Stewart sidecar)

Settings → `settings.yaml`: `log: { level: off|calls|full, retainDays: 7 }` (default `off`, `7`).

- `off`: nothing is written.
- `calls`: provider requests, responses, HTTP/connection errors, stream errors and Claude CLI stdin/stdout/stderr/exit.
- `full`: `calls` plus every bus event as `[core] [-]` with a JSON payload. `text_delta` frames are skipped.

Core: `packages/core/src/debug/debug.ts` (`DebugLogger` gating + redaction, `formatDebugLine`, `redact`, `eventEntry`).
Adapters receive the logger via `ChannelDeps.debug` / `ClaudeDeps.debug`. Core builds the sink through
`CoreDeps.debugSinkFactory` when `settings.log.level` is not `off`, and rebuilds it only when level or
`retainDays` change (checked on attach and reload). Logging never throws and never breaks a call.

Sidecar: `packages/sidecar/src/debugSink.ts` (`FileDebugSink`, `pruneDebugLogs`). The host announces the folder
with a `log.dir` notification (JetBrains: `PathManager.getLogPath()/stewart/debug_logs`). Lines arriving before
`log.dir` are dropped. The sidecar never writes to stderr.

Format: one line per record in `<dir>/yyyy-MM-dd.log` (UTC day, appended, mode `0600`, folder `0700`):
`[<ISO-8601>] [<direction>] [<provider>] [<model>] [<payload>]`. Directions: `outgoing`, `incoming`, `stderr`,
`error`, `event`. `\`, CR, LF and TAB are escaped in every field. Writes are buffered (about 250 ms) and flushed on exit.

Redaction (before the sink): `Authorization` header values, standalone `Bearer <token>` and every stored channel
secret value become `[REDACTED]`. Prompt and response text is otherwise verbatim, so treat the files as sensitive.

Retention: `retainDays` 0 keeps everything; N keeps today (UTC) plus the previous N days. Pruning runs when the
sink is created and when a new day's file is first written. Only files named `yyyy-MM-dd(.N)?.log` whose first
line matches the format are deleted; foreign files are kept.

Not yet: size-based rotation (`.N.log` names are accepted by pruning, but nothing creates them), a settings UI
for `log`, and per-project levels (the last loaded project's setting wins).

---

## v1 (reference)

Opt-in record of every model call, for diagnosing provider and prompt problems without a debugger.
Implemented by `com.adb.stewart.debug.DebugLogSink`.

## Enabling

Settings → Tools → Stewart (settings stored in `stewart.xml`; old AIJB settings are migrated on first load, see `docs/archived_v1/RENAME_PLAN.md`):

- **Debug log: record every model call (Ollama, AIF, Claude CLI)** — master switch, off by default.
- **Debug log folder** — defaults to `./log/debug_logs/`. Relative paths resolve under the IDE log
  directory (`PathManager.getLogPath()`), so the default lands in `<IDE log>/log/debug_logs/`.
  On Apply with logging on, a missing folder is created: silently under the IDE log directory, after a
  Yes/No prompt anywhere else. Declining, or a creation failure (e.g. permission denied), rejects the Apply.
  Absolute paths are used as-is.

Saved settings apply immediately; opening the chat panel also applies them at startup.

## Format

One line per event, appended to a UTC-daily file (`yyyy-MM-dd.log`):

```
[<ISO-8601 timestamp>] [<direction>] [<provider>] [<model>] [<payload>]
```

Directions: `outgoing` (request payload / Claude stdin), `incoming` (response chunk),
`stderr` (Claude CLI stderr), `error` (HTTP error body, connection failure, incomplete stream).

Ollama `outgoing` payloads are prefixed `num_ctx=<N|default> ` before the request JSON.

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

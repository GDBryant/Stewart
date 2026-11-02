# Debug Log Retention — Plan

Status: **planned** (not yet implemented). Fixes gaps in the current retention behaviour in
`src/main/kotlin/com/aijb/assistant/debug/DebugLogSink.kt` and documents the intended design.

## Current behaviour

- `pruneOldLogs` only runs inside `writerFor` — stale files survive indefinitely when logging is
  off, and within a single day once the writer is open.
- Retention is hard-coded: `RETENTION_DAYS = 7`.
- Pruning deletes *any* file named `yyyy-MM-dd.log` in the configured folder, which can hit
  unrelated files if the folder is shared.
- No per-file size cap: one day of streaming can grow unbounded.
- Two IDE instances sharing a folder can delete a file the other is writing.
- Prune failures are swallowed silently (`runCatching`).

## Work items

1. **Prune independently of file open**
   - Add `pruneNow()` that resolves `logDirectory` and runs `pruneOldLogs` on the writer thread.
   - Call it from `configure()` when `enabled=true`, so opening the panel / applying settings
     enforces retention even with no model traffic.

2. **Configurable retention**
   - `AijbSettings.State.debugLogRetentionDays` — default 7, `0` = keep forever, clamp 0–365.
   - `AijbConfigurable`: new row "Debug log retention (days):", plus `isModified`/`reset`/`apply`
     wiring; apply pushes it to `DebugLogSink` alongside `configure`.
   - `DebugLogSink`: `@Volatile var retentionDays = RETENTION_DAYS`; `RETENTION_DAYS` stays as the
     constant default only.

3. **Per-file size cap / rotation**
   - `MAX_FILE_BYTES = 50 * 1024 * 1024` (constant, no setting).
   - When the open file exceeds the cap, rotate to `yyyy-MM-dd.1.log`, `yyyy-MM-dd.2.log`, …
     (first free suffix) and reopen the base name.
   - `pruneOldLogs` matches `yyyy-MM-dd(.N)?.log`, i.e. the date prefix, not the exact name.

4. **Only delete files the sink wrote**
   - Before deleting, read the first line and require the line format
     `^\[[0-9T:.\-]+Z\] \[[a-z]+\] \[.+\] \[.+\] \[`, so foreign `yyyy-MM-dd.log` files survive.

5. **Multi-instance safety**
   - Skip deletion of files whose `lastModifiedTime` is within the last hour.
   - Note in code/docs that last-writer-wins is accepted beyond that.

6. **Report prune failures**
   - Route failures through `reportFailure` (single-shot) instead of bare `runCatching`.

## Tests

- `DebugLogSinkTest`:
  - `configure` with `enabled=true` prunes stale files without any `log()` call
  - boundary: file dated exactly `retentionDays` ago kept, one older deleted; `0` keeps all
  - rotation: second file gets `.1` suffix after exceeding a small injected cap
  - foreign `yyyy-MM-dd.log` without the sink prefix is kept
  - recently-modified stale file is skipped
  - prune failure is reported once, not repeated
- `AijbSettingsTest`: `debugLogRetentionDays` serializes/deserializes.
- `AijbConfigurableTest`: field reset/apply/modified, range validation (`-1`, `400` rejected or clamped).

## Docs

- Update `docs/DEBUG_LOGGING.md`: configurable retention, rotation naming, ownership rule.
- Update the settings row label to show the retention is in days.

## Acceptance

- `./gradlew test` and `./gradlew koverVerify` pass.
- Manual: set retention to 1 day, place a two-day-old `yyyy-MM-dd.log` with a valid first line in
  the folder, open the chat panel → file is deleted.

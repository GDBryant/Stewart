# Debug Log Retention — Plan

Status: **planned** (not yet implemented). Fixes gaps in the current retention behaviour in
`src/main/kotlin/com/aijb/assistant/debug/DebugLogSink.kt`. Current behaviour is described in
`docs/DEBUG_LOGGING.md`.

## Current behaviour

- `pruneOldLogs` only runs inside `writerFor` — stale files survive indefinitely when logging is
  off, and within a single day once the writer is open.
- Retention is hard-coded: `RETENTION_DAYS = 7`. Cutoff is `today - 7` with `isBefore`, so today's
  file plus the previous 7 days are kept (8 files).
- Pruning deletes *any* file named `yyyy-MM-dd.log` in the configured folder, including files the
  sink did not write.
- No per-file size cap: one day of streaming can grow unbounded.
- Prune failures are swallowed silently (`runCatching`).

## Decisions

- **Retention range:** 0–365 days. Out-of-range or non-numeric input is **rejected** with
  `ConfigurationException`, matching `historyRetentionDays`. No clamping.
- **Retention semantics:** `N > 0` keeps today plus the previous `N` days (unchanged). `0` means
  **never prune** — an explicit branch, not `cutoff = today`.
- **Rotation across IDE instances:** rotation happens only while holding an exclusive
  `FileChannel.tryLock()` on `<folder>/.aijb-debug.lock`. If the lock is not acquired, skip
  rotation and keep appending (the size cap is soft). Writers detect a rotated-away file and
  reopen (item 4).
- **Failure reporting:** prune failures get their own one-shot flag (`pruneFailureReported`),
  separate from write failures, so an earlier write failure cannot hide prune failures.

## Work items

1. **Prune independently of file open**
   - `pruneNow(dir: Path)` runs `pruneOldLogs` on the writer thread.
   - `configure()` calls it when `enabled=true`. Both call sites (`AijbConfigurable.apply` and
     `ChatPanel` init) therefore enforce retention without any model traffic.

2. **Configurable retention**
   - `AijbSettings.State.debugLogRetentionDays by property(7)`.
   - `AijbConfigurable`: row "Debug log retention (days, 0 = keep forever):"; `isModified`,
     `reset`, `apply` wiring; validation per Decisions.
   - `DebugLogSink.configure(enabled, directory, retentionDays = RETENTION_DAYS)`; stored in a
     `@Volatile var retentionDays`. Update both call sites, `AijbConfigurable.apply` and
     `ChatPanel` init, to pass the setting.

3. **Per-file size cap / rotation**
   - `internal var maxFileBytes = 50L * 1024 * 1024` (`internal var` so tests can lower it).
   - Track `bytesWritten`: initialise from `Files.size(file)` when the writer opens, then add each
     line's UTF-8 byte length. Do not call `Files.size` per write (the writer is buffered).
   - When `bytesWritten >= maxFileBytes`: take the lock, **flush and close the writer first**
     (required on Windows), rename the base file to the first free `yyyy-MM-dd.N.log` (N ≥ 1),
     release the lock, reopen the base name.
   - Ordering: `.1` is the oldest chunk of the day, higher N newer, base file newest. Sort
     numerically on N, not lexically (`.10` after `.9`).
   - `pruneOldLogs` matches `^(\d{4}-\d{2}-\d{2})(\.\d+)?\.log$` and prunes by the date group, so
     a day's rotated files are deleted together.

4. **Reopen after another instance rotates**
   - Store the open file's `BasicFileAttributes.fileKey()` when the writer opens (null on
     filesystems without keys).
   - Before each write, if the base path is missing or its `fileKey` differs, close and reopen.
     This keeps a second IDE from writing into a file that was renamed under it.

5. **Only delete files the sink wrote**
   - Before deleting, read the first line and require
     `^\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\] \[[a-z]+\] \[[^\]]*\] \[[^\]]*\] \[`.
   - Files that don't match, or can't be read, are kept.

6. **Report prune failures**
   - Replace the bare `runCatching` in `pruneOldLogs` with `reportPruneFailure(e)`, which uses the
     `pruneFailureReported` flag.

## Tests

- `DebugLogSinkTest`:
  - `configure(enabled=true)` prunes stale files with no `log()` call; `enabled=false` does not
  - boundary: with `N = 3`, a file dated `today - 3` is kept and `today - 4` is deleted
  - `retentionDays = 0` keeps a file dated `2000-01-01`
  - rotation: with `maxFileBytes` lowered, writes produce `yyyy-MM-dd.1.log`, `.2.log` and the
    base file; line order across them matches write order
  - rotation ordering: `.10` sorts after `.9` in the helper used for ordering
  - rotated files of a stale day are pruned together with the base file
  - lock held elsewhere: rotation is skipped and writes continue to the base file
  - base file renamed externally: next write reopens and lands in a fresh base file
  - foreign `yyyy-MM-dd.log` without the sink's first-line format is kept
  - a prune failure is reported once and does not depend on the write-failure flag
- `AijbSettingsTest`: `debugLogRetentionDays` default and XML round-trip.
- `AijbConfigurableTest`: reset/apply/`isModified`; `-1`, `366`, `abc` rejected; `0` and `365`
  accepted; apply pushes the value to `DebugLogSink.retentionDays`.
- `ChatPanelTest`: panel init passes `debugLogRetentionDays` to the sink.

## Docs

- Update `docs/DEBUG_LOGGING.md`: configurable retention, `0` semantics, rotation naming and
  order, ownership rule, lock file. Mark this plan done.
- Update `docs/PROGRESS.md`.

## Acceptance

- `./gradlew test`, `./gradlew koverVerify` and `./gradlew buildPlugin` pass.
- Manual: set retention to 1 day, place a sink-formatted file dated three days ago and a foreign
  `yyyy-MM-dd.log` in the folder, open the chat panel → the sink file is deleted and the foreign
  file stays.

package com.adb.stewart.debug

import com.adb.stewart.provider.aif.AifCredentials
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import java.io.BufferedWriter
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Append-only sink for model-call debug logs (Ollama, AIF, Claude CLI).
 *
 * When [isEnabled] is false, [log] is a no-op. Otherwise each call appends one line
 * to a daily file inside [logDirectory] (created on demand):
 *
 * `[ISO-8601 timestamp] [direction] [provider] [model] [payload]`
 *
 * Payloads are redacted before writing: "Authorization" header values, "Bearer" tokens and
 * the stored AIF API key are replaced with `[REDACTED]`.
 *
 * Writing happens on a background single-thread executor (never the Main/EDT thread), through
 * a buffered writer that is reused until the day or folder changes. Daily files older than
 * [retentionDays] are pruned on [configure] and when a new file is opened (0 = keep forever);
 * only files whose first line has the sink's format are deleted. A day's file rotates to
 * `yyyy-MM-dd.N.log` once it reaches [maxFileBytes]. New files are owner-only where the
 * filesystem supports POSIX permissions. The first write failure and the first prune failure are
 * each reported to the IDE log; later ones are ignored. Logging never throws and never breaks a
 * model call.
 */
object DebugLogSink {

    /** Default days of daily log files kept in [logDirectory]. */
    const val RETENTION_DAYS = 7

    /** Days kept besides today; 0 means never prune. */
    @Volatile var retentionDays: Int = RETENTION_DAYS

    /** Soft per-file size cap; the file rotates to `yyyy-MM-dd.N.log` once reached. */
    @Volatile internal var maxFileBytes: Long = 50L * 1024 * 1024

    /** Target folder for debug logs; created on first write. Relative paths resolve under the IDE log directory. Defaults to `./log/debug_logs/`. */
    @Volatile var logDirectory: String = DEFAULT_DIRECTORY

    /** Master switch; when false [log] does nothing. */
    @Volatile var isEnabled: Boolean = false

    /** Applies the persisted settings; a blank folder falls back to the default. */
    fun configure(enabled: Boolean, directory: String, retentionDays: Int = RETENTION_DAYS) {
        logDirectory = directory.ifBlank { DEFAULT_DIRECTORY }
        this.retentionDays = retentionDays
        isEnabled = enabled
        if (!enabled) return
        try {
            val dir = resolveDirectory(logDirectory)
            writer.execute {
                try {
                    pruneNow(dir)
                } catch (e: Exception) {
                    reportPruneFailure(e)
                }
            }
        } catch (e: Exception) {
            reportPruneFailure(e)
        }
    }

    private val lock = Any()
    internal val failureReported = AtomicBoolean(false)
    internal val pruneFailureReported = AtomicBoolean(false)

    private var openFile: Path? = null
    private var openWriter: BufferedWriter? = null
    private var openKey: Any? = null
    private var bytesWritten = 0L

    /** Single background writer thread: keeps file writes off the Main/EDT thread and ordered. */
    private val writer: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "AIJB-DebugLogSink-Writer").apply { isDaemon = true }
        }
    }

    init {
        runCatching {
            Runtime.getRuntime().addShutdownHook(
                Thread({ runCatching { flushAndClose() } }, "AIJB-DebugLogSink-Flush"))
        }
    }

    fun log(
        direction: String,
        provider: String,
        model: String,
        payload: String,
        timestampMillis: Long = System.currentTimeMillis(),
    ) {
        if (!isEnabled) return
        try {
            val line = formatLine(direction, provider, model, payload, timestampMillis)
            // Resolve now so a settings change cannot split one call across two folders.
            val dir = resolveDirectory(logDirectory)
            writer.execute {
                try {
                    appendToFile(dir, line, timestampMillis)
                } catch (e: Exception) {
                    reportFailure(e)
                }
            }
        } catch (e: Exception) {
            reportFailure(e)
        }
    }

    internal fun formatLine(
        direction: String,
        provider: String,
        model: String,
        payload: String,
        timestampMillis: Long,
    ): String {
        val ts = Instant.ofEpochMilli(timestampMillis).toString()
        return "[${ts}] [${sanitize(direction)}] [${sanitize(provider)}] " +
            "[${sanitize(model)}] [${sanitize(redact(payload))}]\n"
    }

    /** Flushes the open writer; called from tests and the shutdown hook. */
    internal fun flush() {
        synchronized(lock) {
            runCatching { openWriter?.flush() }
        }
    }

    /** Best-effort flush and close of the open daily file. */
    internal fun flushAndClose() {
        flush()
        synchronized(lock) {
            closeWriter()
        }
    }

    /** Best-effort redaction of "Authorization", "Bearer" and the stored AIF API key. */
    private fun redact(payload: String): String {
        var result = AUTHORIZATION_VALUE.replace(payload) { match ->
            match.groupValues[1] + "[REDACTED]"
        }
        result = BEARER_TOKEN.replace(result, "Bearer [REDACTED]")
        currentAifApiKey()?.takeIf { it.isNotBlank() }?.let { key ->
            result = result.replace(key, "[REDACTED]")
        }
        return result
    }

    private fun currentAifApiKey(): String? = try {
        AifCredentials.get()
    } catch (t: Throwable) {
        null // Credential store access is optional/best-effort in the debug path.
    }

    private fun reportFailure(e: Throwable) {
        if (!failureReported.compareAndSet(false, true)) return
        warn("AIJB debug log write failed; further failures are not reported", e)
    }

    private fun reportPruneFailure(e: Throwable) {
        if (!pruneFailureReported.compareAndSet(false, true)) return
        warn("AIJB debug log prune failed; further prune failures are not reported", e)
    }

    private fun warn(message: String, e: Throwable) {
        try {
            Logger.getInstance(DebugLogSink::class.java).warn(message, e)
        } catch (t: Throwable) {
            // Reporting must not break a model call either.
        }
    }

    private fun appendToFile(dir: Path, line: String, timestampMillis: Long) {
        synchronized(lock) {
            val file = dir.resolve(fileNameFor(timestampMillis))
            try {
                dropIfRotatedAway(file)
                var w = writerFor(dir, file)
                if (bytesWritten >= maxFileBytes && rotate(dir, file)) w = writerFor(dir, file)
                w.write(line)
                w.flush()
                bytesWritten += line.toByteArray(Charsets.UTF_8).size
            } catch (e: IOException) {
                closeWriter()
                throw e
            }
        }
    }

    /** Closes the writer if another instance renamed or replaced the open file. */
    private fun dropIfRotatedAway(file: Path) {
        if (openWriter == null || openFile != file) return
        val attrs = runCatching { Files.readAttributes(file, BasicFileAttributes::class.java) }.getOrNull()
        if (attrs == null || (openKey != null && attrs.fileKey() != openKey)) closeWriter()
    }

    private fun writerFor(dir: Path, file: Path): BufferedWriter {
        openWriter?.let { if (openFile == file) return it }
        closeWriter()
        if (!Files.isDirectory(dir)) Files.createDirectories(dir)
        val created = !Files.exists(file)
        val w = Files.newBufferedWriter(
            file, StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE)
        if (created) {
            runCatching { Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------")) }
        }
        bytesWritten = runCatching { Files.size(file) }.getOrDefault(0L)
        openKey = runCatching { Files.readAttributes(file, BasicFileAttributes::class.java).fileKey() }.getOrNull()
        pruneOldLogs(dir, keep = file)
        openFile = file
        openWriter = w
        return w
    }

    private fun closeWriter() {
        runCatching { openWriter?.close() }
        openWriter = null
        openFile = null
        openKey = null
    }

    /**
     * Renames the full base file to the first free `yyyy-MM-dd.N.log`. Only done while holding the
     * folder's lock file; returns false (keep appending) when another instance holds it.
     */
    private fun rotate(dir: Path, file: Path): Boolean {
        val channel = try {
            FileChannel.open(dir.resolve(LOCK_FILE_NAME), StandardOpenOption.CREATE, StandardOpenOption.WRITE)
        } catch (e: IOException) {
            return false
        }
        channel.use { ch ->
            val held = try {
                ch.tryLock()
            } catch (e: OverlappingFileLockException) {
                null
            } ?: return false
            held.use {
                closeWriter() // Flush and close before the rename (required on Windows).
                // Another instance may have rotated already: only move a file that is still full.
                if (Files.exists(file) && Files.size(file) >= maxFileBytes) {
                    val base = file.fileName.toString().removeSuffix(".log")
                    var n = 1
                    while (Files.exists(dir.resolve("$base.$n.log"))) n++
                    Files.move(file, dir.resolve("$base.$n.log"))
                }
            }
        }
        return true
    }

    /** Applies retention to [dir] now; used by [configure] and when a new daily file opens. */
    internal fun pruneNow(dir: Path) {
        synchronized(lock) {
            if (Files.exists(dir)) pruneOldLogs(dir, keep = null)
        }
    }

    /**
     * Deletes daily files (and their rotated chunks) older than [retentionDays]. Only files whose
     * first line has the sink's format are deleted; anything else in the folder is left alone.
     */
    private fun pruneOldLogs(dir: Path, keep: Path?) {
        val days = retentionDays
        if (days <= 0) return
        val cutoff = LocalDate.now(ZoneOffset.UTC).minusDays(days.toLong())
        try {
            Files.list(dir).use { files ->
                files.forEach { file ->
                    if (file == keep) return@forEach
                    val match = DAY_FILE_PATTERN.matchEntire(file.fileName.toString()) ?: return@forEach
                    val day = runCatching { LocalDate.parse(match.groupValues[1]) }.getOrNull()
                        ?: return@forEach
                    if (!day.isBefore(cutoff) || !isSinkFile(file)) return@forEach
                    try {
                        Files.deleteIfExists(file)
                    } catch (e: IOException) {
                        reportPruneFailure(e)
                    }
                }
            }
        } catch (e: IOException) {
            reportPruneFailure(e)
        }
    }

    private fun isSinkFile(file: Path): Boolean = try {
        Files.newBufferedReader(file).use { it.readLine() }?.let { SINK_LINE.containsMatchIn(it) } ?: false
    } catch (e: IOException) {
        false
    }

    /** Orders a folder's log files chronologically: by day, then `.1`, `.2` … `.10`, then the base file. */
    internal fun orderedLogs(dir: Path): List<Path> =
        Files.list(dir).use { files ->
            files.toList().mapNotNull { f ->
                DAY_FILE_PATTERN.matchEntire(f.fileName.toString())?.let { m ->
                    Triple(m.groupValues[1], m.groupValues[2].toIntOrNull() ?: Int.MAX_VALUE, f)
                }
            }
        }.sortedWith(compareBy({ it.first }, { it.second })).map { it.third }

    /** Relative folders are anchored under the IDE log directory so `./log/...` is well-defined. */
    internal fun resolveDirectory(raw: String): Path {
        val dir = Path.of(raw)
        if (dir.isAbsolute) return dir
        return Path.of(PathManager.getLogPath()).resolve(dir).normalize()
    }

    private fun fileNameFor(timestampMillis: Long): String =
        DAY_FILE_FORMAT.format(Instant.ofEpochMilli(timestampMillis)) + ".log"

    /** Keeps one log line per call: escapes line breaks and tabs in payloads. */
    private fun sanitize(value: String): String = value
        .replace("\\", "\\\\")
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")

    private val DAY_FILE_FORMAT: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC)

    // Group 1 = day, group 2 = rotation number (empty for the base file).
    private val DAY_FILE_PATTERN: Regex = Regex("(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.log")

    private val SINK_LINE: Regex =
        Regex("^\\[\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z\\] \\[[a-z]+\\] \\[[^\\]]*\\] \\[[^\\]]*\\] \\[")

    private const val LOCK_FILE_NAME = ".stewart-debug.lock"

    // `Authorization: <value>` (header style) or `"Authorization": "<value>"` (JSON style);
    // the value stops at quote, comma, closing brace or end of line.
    private val AUTHORIZATION_VALUE: Regex =
        Regex("(?i)(authorization[\"']?\\s*[:=]\\s*[\"']?)[^\"\\r\\n,}]*")

    // Standalone `Bearer <token>` values (Authorization headers are already masked above);
    // restricted to same-line matches so multi-line payloads are not merged.
    private val BEARER_TOKEN: Regex =
        Regex("(?i)bearer[ \t]+[^\"\\s,}]+")
}

private const val DEFAULT_DIRECTORY = "./log/debug_logs/"

package com.aijb.assistant.debug

import com.aijb.assistant.provider.aif.AifCredentials
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import java.io.BufferedWriter
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
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
 * [RETENTION_DAYS] are pruned when a new file is opened, and new files are owner-only where the
 * filesystem supports POSIX permissions. The first I/O failure is reported to the IDE log; later
 * ones are ignored. Logging never throws and never breaks a model call.
 */
object DebugLogSink {

    /** Days of daily log files kept in [logDirectory]; older files are deleted on the next open. */
    const val RETENTION_DAYS = 7

    /** Target folder for debug logs; created on first write. Relative paths resolve under the IDE log directory. Defaults to `./log/debug_logs/`. */
    @Volatile var logDirectory: String = DEFAULT_DIRECTORY

    /** Master switch; when false [log] does nothing. */
    @Volatile var isEnabled: Boolean = false

    /** Applies the persisted settings; a blank folder falls back to the default. */
    fun configure(enabled: Boolean, directory: String) {
        logDirectory = directory.ifBlank { DEFAULT_DIRECTORY }
        isEnabled = enabled
    }

    private val lock = Any()
    private val failureReported = AtomicBoolean(false)

    private var openFile: Path? = null
    private var openWriter: BufferedWriter? = null

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
            runCatching { openWriter?.close() }
            openWriter = null
            openFile = null
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
        try {
            Logger.getInstance(DebugLogSink::class.java)
                .warn("AIJB debug log write failed; further failures are not reported", e)
        } catch (t: Throwable) {
            // Reporting must not break a model call either.
        }
    }

    private fun appendToFile(dir: Path, line: String, timestampMillis: Long) {
        synchronized(lock) {
            val file = dir.resolve(fileNameFor(timestampMillis))
            try {
                val w = writerFor(dir, file)
                w.write(line)
                w.flush()
            } catch (e: IOException) {
                closeWriter()
                throw e
            }
        }
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
        pruneOldLogs(dir, keep = file)
        openFile = file
        openWriter = w
        return w
    }

    private fun closeWriter() {
        runCatching { openWriter?.close() }
        openWriter = null
        openFile = null
    }

    /** Deletes daily files older than [RETENTION_DAYS]; anything else in the folder is left alone. */
    private fun pruneOldLogs(dir: Path, keep: Path) {
        val cutoff = LocalDate.now(ZoneOffset.UTC).minusDays(RETENTION_DAYS.toLong())
        runCatching {
            Files.list(dir).use { files ->
                files.forEach { file ->
                    if (file == keep) return@forEach
                    val name = file.fileName.toString()
                    if (!DAY_FILE_PATTERN.matches(name)) return@forEach
                    val day = runCatching { LocalDate.parse(name.removeSuffix(".log")) }.getOrNull()
                    if (day != null && day.isBefore(cutoff)) runCatching { Files.delete(file) }
                }
            }
        }
    }

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

    private val DAY_FILE_PATTERN: Regex = Regex("\\d{4}-\\d{2}-\\d{2}\\.log")

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

package com.aijb.assistant.debug

import com.aijb.assistant.provider.aif.AifCredentials
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

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
 * Writing happens on a background single-thread executor (never the Main/EDT thread) and
 * never throws: I/O failures are swallowed so debug logging cannot break a model call.
 */
object DebugLogSink {

    /** Target folder for debug logs; created on first write. Defaults to `./log/debug_logs/`. */
    @Volatile var logDirectory: String = DEFAULT_DIRECTORY

    /** Master switch; when false [log] does nothing. */
    @Volatile var isEnabled: Boolean = false

    /** Applies the persisted settings; a blank folder falls back to the default. */
    fun configure(enabled: Boolean, directory: String) {
        logDirectory = directory.ifBlank { DEFAULT_DIRECTORY }
        isEnabled = enabled
    }

    private val lock = Any()

    /** Single background writer thread: keeps file writes off the Main/EDT thread and ordered. */
    private val writer: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "AIJB-DebugLogSink-Writer").apply { isDaemon = true }
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
            writer.execute {
                try {
                    appendToFile(line, timestampMillis)
                } catch (e: Exception) {
                    // Debug logging must never break a model call.
                }
            }
        } catch (e: Exception) {
            // Redaction, formatting or enqueueing must never break a model call either.
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

    private fun appendToFile(line: String, timestampMillis: Long) {
        synchronized(lock) {
            val dir = Path.of(logDirectory)
            if (!Files.isDirectory(dir)) Files.createDirectories(dir)
            val file = dir.resolve(fileNameFor(timestampMillis))
            Files.writeString(file, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND)
        }
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

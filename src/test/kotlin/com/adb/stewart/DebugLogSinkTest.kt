package com.adb.stewart

import com.adb.stewart.debug.DebugLogSink
import java.nio.file.Files
import java.nio.file.Path
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private const val SINK_LINE = "[2000-01-01T00:00:00Z] [outgoing] [ollama] [m] [payload]\n"

class DebugLogSinkTest {

    private lateinit var dir: Path
    private var previousEnabled = false
    private var previousDirectory = ""

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("stewart-sink-")
        previousEnabled = DebugLogSink.isEnabled
        previousDirectory = DebugLogSink.logDirectory
    }

    @After
    fun tearDown() {
        DebugLogSink.maxFileBytes = 50L * 1024 * 1024
        DebugLogSink.flushAndClose()
        DebugLogSink.configure(previousEnabled, previousDirectory)
    }

    /** Waits for a log file that already has content; the sink creates the file before its first write. */
    private fun awaitFile(folder: Path = dir): Path {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (Files.isDirectory(folder)) {
                Files.list(folder).use { it.toList() }
                    .firstOrNull { Files.isRegularFile(it) && Files.size(it) > 0 }
                    ?.let { return it }
            }
            Thread.sleep(10)
        }
        throw AssertionError("no log file was written")
    }

    @Test
    fun `disabled sink writes nothing`() {
        DebugLogSink.configure(false, dir.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        Thread.sleep(100)
        assertTrue(Files.list(dir).use { it.toList() }.isEmpty())
    }

    @Test
    fun `enabled sink writes one formatted line per daily file`() {
        DebugLogSink.configure(true, dir.resolve("nested/").toString())
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 1_704_164_645_000L)
        val file = awaitFile(dir.resolve("nested"))
        assertEquals("2024-01-02.log", file.fileName.toString())
        assertEquals(
            "[2024-01-02T03:04:05Z] [outgoing] [ollama] [m] [payload]",
            Files.readAllLines(file).single(),
        )
    }

    @Test
    fun `payloads are redacted`() {
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.log(
            "outgoing",
            "aif",
            "m",
            "Authorization: Bearer secret-header\n{\"Authorization\":\"Bearer secret-json\"} Bearer secret-token",
            0L,
        )
        val text = Files.readString(awaitFile())
        assertFalse(text.contains("secret-header"))
        assertFalse(text.contains("secret-json"))
        assertFalse(text.contains("secret-token"))
        assertTrue(text.contains("[REDACTED]"))
    }

    @Test
    fun `payload line breaks and tabs are escaped`() {
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.log("incoming", "claude", "m", "a\nb\tc\\d\r", 0L)
        val file = awaitFile()
        assertEquals(
            "[1970-01-01T00:00:00Z] [incoming] [claude] [m] [a\\nb\\tc\\\\d\\r]",
            Files.readAllLines(file).single(),
        )
    }

    @Test
    fun `configure falls back to the default folder when blank`() {
        DebugLogSink.configure(true, "  ")
        assertTrue(DebugLogSink.isEnabled)
        assertEquals("./log/debug_logs/", DebugLogSink.logDirectory)
    }

    @Test
    fun `lines append to one file and the writer is reused`() {
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "one", 1_704_164_645_000L)
        DebugLogSink.log("incoming", "ollama", "m", "two", 1_704_164_646_000L)
        val file = awaitFile()
        val deadline = System.currentTimeMillis() + 10_000
        var lines = Files.readAllLines(file)
        while (lines.size < 2 && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
            lines = Files.readAllLines(file)
        }
        assertEquals(2, lines.size)
        assertTrue(lines[0].endsWith("[one]"))
        assertTrue(lines[1].endsWith("[two]"))
    }

    @Test
    fun `a new day opens a new file`() {
        DebugLogSink.configure(true, dir.toString())
        val now = System.currentTimeMillis()
        val yesterday = now - 86_400_000L
        DebugLogSink.log("outgoing", "ollama", "m", "one", yesterday)
        DebugLogSink.log("outgoing", "ollama", "m", "two", now)
        val names = listOf(
            java.time.LocalDate.ofInstant(java.time.Instant.ofEpochMilli(yesterday), java.time.ZoneOffset.UTC),
            java.time.LocalDate.ofInstant(java.time.Instant.ofEpochMilli(now), java.time.ZoneOffset.UTC),
        ).map { "$it.log" }.sorted()
        val deadline = System.currentTimeMillis() + 10_000
        var files = emptyList<Path>()
        while (System.currentTimeMillis() < deadline) {
            files = Files.list(dir).use { it.toList() }.sortedBy { it.fileName.toString() }
            if (files.size >= 2) break
            Thread.sleep(10)
        }
        assertEquals(names, files.map { it.fileName.toString() })
        assertTrue(Files.readAllLines(files[0]).single().endsWith("[one]"))
        assertTrue(Files.readAllLines(files[1]).single().endsWith("[two]"))
    }

    @Test
    fun `daily files older than retention are pruned and other files kept`() {
        DebugLogSink.configure(true, dir.toString())
        val old = dir.resolve("2000-01-01.log")
        val notes = dir.resolve("notes.txt")
        Files.writeString(old, SINK_LINE)
        Files.writeString(notes, "keep\n")
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        val fresh = dir.resolve("1970-01-01.log")
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline && !Files.exists(fresh)) Thread.sleep(10)
        assertTrue(Files.exists(fresh))
        assertFalse(Files.exists(old))
        assertTrue(Files.exists(notes))
    }

    private val today = java.time.LocalDate.now(java.time.ZoneOffset.UTC)

    private fun daysAgo(n: Long) = today.minusDays(n)

    private fun sinkFile(day: java.time.LocalDate, suffix: String = ""): Path =
        Files.writeString(dir.resolve("$day$suffix.log"), SINK_LINE)

    private fun await(cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline && !cond()) Thread.sleep(10)
        assertTrue("condition not met", cond())
    }

    @Test
    fun `configure enabled prunes stale files without any log call`() {
        val stale = sinkFile(daysAgo(30))
        DebugLogSink.configure(true, dir.toString(), 7)
        await { !Files.exists(stale) }
    }

    @Test
    fun `configure disabled does not prune`() {
        val stale = sinkFile(daysAgo(30))
        DebugLogSink.configure(false, dir.toString(), 7)
        Thread.sleep(150)
        assertTrue(Files.exists(stale))
    }

    @Test
    fun `retention boundary keeps N days and deletes older`() {
        val kept = sinkFile(daysAgo(3))
        val gone = sinkFile(daysAgo(4))
        DebugLogSink.configure(false, dir.toString(), 3)
        DebugLogSink.retentionDays = 3
        DebugLogSink.pruneNow(dir)
        assertTrue(Files.exists(kept))
        assertFalse(Files.exists(gone))
    }

    @Test
    fun `retention zero never prunes`() {
        val ancient = dir.resolve("2000-01-01.log").also { Files.writeString(it, SINK_LINE) }
        DebugLogSink.configure(true, dir.toString(), 0)
        Thread.sleep(150)
        DebugLogSink.pruneNow(dir)
        assertTrue(Files.exists(ancient))
    }

    @Test
    fun `foreign day-named file is kept`() {
        val foreign = dir.resolve("2000-01-01.log").also { Files.writeString(it, "not ours\n") }
        val empty = dir.resolve("2000-01-02.log").also { Files.writeString(it, "") }
        DebugLogSink.retentionDays = 7
        DebugLogSink.pruneNow(dir)
        assertTrue(Files.exists(foreign))
        assertTrue(Files.exists(empty))
    }

    @Test
    fun `rotated chunks of a stale day are pruned with the base file`() {
        val files = listOf("", ".1", ".2").map { sinkFile(daysAgo(30), it) }
        val fresh = sinkFile(today, ".1")
        DebugLogSink.retentionDays = 7
        DebugLogSink.pruneNow(dir)
        files.forEach { assertFalse(Files.exists(it)) }
        assertTrue(Files.exists(fresh))
    }

    @Test
    fun `prune failure is reported once independently of write failures`() {
        val notADir = Files.createTempFile("stewart-sink-file", ".x")
        DebugLogSink.failureReported.set(true)
        DebugLogSink.pruneFailureReported.set(false)
        DebugLogSink.retentionDays = 7
        try {
            DebugLogSink.pruneNow(notADir)
            assertTrue(DebugLogSink.pruneFailureReported.get())
            DebugLogSink.pruneNow(dir.resolve("missing"))
        } finally {
            DebugLogSink.failureReported.set(false)
            DebugLogSink.pruneFailureReported.set(false)
        }
    }

    @Test
    fun `missing folder is not a prune failure`() {
        DebugLogSink.pruneFailureReported.set(false)
        DebugLogSink.pruneNow(dir.resolve("missing"))
        assertFalse(DebugLogSink.pruneFailureReported.get())
    }

    /** Snapshot read; a file renamed by a concurrent rotation yields an empty list so callers retry. */
    private fun logLines(folder: Path = dir): List<String> = try {
        DebugLogSink.orderedLogs(folder).flatMap { Files.readAllLines(it) }
    } catch (e: java.nio.file.NoSuchFileException) {
        emptyList()
    }

    @Test
    fun `full file rotates and line order is preserved`() {
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.maxFileBytes = 100
        val ts = System.currentTimeMillis()
        (1..6).forEach { DebugLogSink.log("outgoing", "ollama", "m", "msg-$it-" + "x".repeat(60), ts) }
        await { logLines().size == 6 }
        DebugLogSink.flush()
        val day = DebugLogSink.orderedLogs(dir).map { it.fileName.toString() }
        assertTrue(day.size >= 3)
        assertTrue(day.contains("$today.1.log"))
        assertTrue(day.contains("$today.2.log"))
        assertEquals("$today.log", day.last())
        assertEquals((1..6).map { "msg-$it-" }, logLines().map { Regex("msg-\\d+-").find(it)!!.value })
    }

    @Test
    fun `ordering is numeric not lexical`() {
        listOf(".10", ".9", ".2", "").forEach { sinkFile(today, it) }
        assertEquals(
            listOf("$today.2.log", "$today.9.log", "$today.10.log", "$today.log"),
            DebugLogSink.orderedLogs(dir).map { it.fileName.toString() },
        )
    }

    @Test
    fun `rotation is skipped while the lock is held elsewhere`() {
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.maxFileBytes = 50
        val ts = System.currentTimeMillis()
        java.nio.channels.FileChannel.open(
            dir.resolve(".stewart-debug.lock"),
            java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE,
        ).use { ch ->
            val held = ch.lock()
            try {
                (1..4).forEach { DebugLogSink.log("outgoing", "ollama", "m", "p$it-" + "x".repeat(40), ts) }
                await { logLines().size == 4 }
                assertEquals(
                    listOf("$today.log"),
                    DebugLogSink.orderedLogs(dir).map { it.fileName.toString() },
                )
            } finally {
                held.release()
            }
        }
    }

    @Test
    fun `externally renamed file is reopened as a fresh base file`() {
        DebugLogSink.configure(true, dir.toString())
        val ts = System.currentTimeMillis()
        DebugLogSink.log("outgoing", "ollama", "m", "one", ts)
        await { logLines().size == 1 }
        val base = dir.resolve("$today.log")
        Files.move(base, dir.resolve("$today.1.log"))
        DebugLogSink.log("outgoing", "ollama", "m", "two", ts)
        await { Files.exists(base) && Files.readAllLines(base).size == 1 }
        assertTrue(Files.readAllLines(dir.resolve("$today.1.log")).single().endsWith("[one]"))
        assertTrue(Files.readAllLines(base).single().endsWith("[two]"))
    }

    @Test
    fun `flush and close keeps later lines working`() {
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "one", 0L)
        DebugLogSink.flushAndClose()
        DebugLogSink.log("outgoing", "ollama", "m", "two", 1_000L)
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline && Files.readAllLines(awaitFile()).size < 2) {
            Thread.sleep(10)
        }
        assertEquals(2, Files.readAllLines(awaitFile()).size)
    }

    @Test
    fun `new files are owner-only on posix filesystems`() {
        org.junit.Assume.assumeTrue(Files.getFileStore(dir).supportsFileAttributeView("posix"))
        DebugLogSink.configure(true, dir.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        val file = awaitFile()
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(
            Files.getPosixFilePermissions(file)))
    }

    @Test
    fun `write failures are swallowed`() {
        val blocker = Files.createTempFile("stewart-sink-blocker", ".log")
        DebugLogSink.configure(true, blocker.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        Thread.sleep(100)
        assertTrue(Files.exists(blocker))
    }
}

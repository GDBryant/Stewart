package com.aijb.assistant

import com.aijb.assistant.debug.DebugLogSink
import java.nio.file.Files
import java.nio.file.Path
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DebugLogSinkTest {

    private lateinit var dir: Path
    private var previousEnabled = false
    private var previousDirectory = ""

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("aijb-sink-")
        previousEnabled = DebugLogSink.isEnabled
        previousDirectory = DebugLogSink.logDirectory
    }

    @After
    fun tearDown() {
        DebugLogSink.configure(previousEnabled, previousDirectory)
    }

    private fun awaitFile(folder: Path = dir): Path {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (Files.isDirectory(folder)) {
                Files.list(folder).use { it.toList() }.firstOrNull()?.let { return it }
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
        assertEquals(2, Files.readAllLines(file).size)
        assertTrue(Files.readAllLines(file)[0].endsWith("[one]"))
        assertTrue(Files.readAllLines(file)[1].endsWith("[two]"))
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
        Files.writeString(old, "stale\n")
        Files.writeString(notes, "keep\n")
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        val fresh = dir.resolve("1970-01-01.log")
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline && !Files.exists(fresh)) Thread.sleep(10)
        assertTrue(Files.exists(fresh))
        assertFalse(Files.exists(old))
        assertTrue(Files.exists(notes))
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
        val blocker = Files.createTempFile("aijb-sink-blocker", ".log")
        DebugLogSink.configure(true, blocker.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        Thread.sleep(100)
        assertTrue(Files.exists(blocker))
    }
}

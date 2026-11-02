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
    fun `write failures are swallowed`() {
        val blocker = Files.createTempFile("aijb-sink-blocker", ".log")
        DebugLogSink.configure(true, blocker.toString())
        DebugLogSink.log("outgoing", "ollama", "m", "payload", 0L)
        Thread.sleep(100)
        assertTrue(Files.exists(blocker))
    }
}

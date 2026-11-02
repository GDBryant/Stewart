package com.adb.stewart

import com.adb.stewart.chat.ChatHistoryStore
import com.adb.stewart.chat.ErrorHints
import com.adb.stewart.chat.UsageFormat
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.Usage
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HistoryAndFormatTest {

    private lateinit var dir: Path
    private lateinit var file: Path
    private lateinit var store: ChatHistoryStore

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("aijb-history-")
        file = ChatHistoryStore.pathFor(dir, "abc123")
        store = ChatHistoryStore(file)
    }

    @After
    fun tearDown() {
        dir.toFile().deleteRecursively()
    }

    private val call = ToolCall("c1", "ReadFile", buildJsonObject { put("path", "a.txt") })
    private val messages = listOf(
        ChatMessage(Role.USER, "hi"),
        ChatMessage(Role.ASSISTANT, "reading", toolCalls = listOf(call)),
        ChatMessage(Role.TOOL, "contents", toolCallId = "c1"),
        ChatMessage(Role.ASSISTANT, "done"),
    )

    // --- store ---

    @Test
    fun `round trips messages tool calls and usage`() {
        store.save(messages, Usage(10, 5, 0.25), now = 1000)
        val loaded = store.load(30, now = 2000)!!
        assertEquals(messages, loaded.messages)
        assertEquals(Usage(10, 5, 0.25), loaded.usage)
        assertEquals(1000L, loaded.savedAt)
    }

    @Test
    fun `usage without any figures loads as null`() {
        store.save(messages, null)
        assertNull(store.load(30)!!.usage)
        store.save(messages, Usage(null, null, null))
        assertNull(store.load(30)!!.usage)
    }

    @Test
    fun `system messages are never persisted`() {
        store.save(listOf(ChatMessage(Role.SYSTEM, "secret role prompt")) + messages, null)
        assertFalse(Files.readString(file).contains("secret role prompt"))
        assertEquals(messages, store.load(30)!!.messages)
    }

    @Test
    fun `saving an empty chat removes the file`() {
        store.save(messages, null)
        assertTrue(Files.exists(file))
        store.save(emptyList(), null)
        assertFalse(Files.exists(file))
        store.save(listOf(ChatMessage(Role.SYSTEM, "only system")), null)
        assertFalse(Files.exists(file))
    }

    @Test
    fun `save leaves no temp file behind`() {
        store.save(messages, null)
        assertEquals(listOf("abc123.json"), Files.list(file.parent).use { s -> s.map { it.fileName.toString() }.toList() })
    }

    @Test
    fun `load of a missing file is null`() {
        assertNull(store.load(30))
    }

    @Test
    fun `expired history is dropped and deleted`() {
        store.save(messages, null, now = 0)
        assertNull(store.load(1, now = TimeUnit.DAYS.toMillis(2)))
        assertFalse(Files.exists(file))
    }

    @Test
    fun `history inside the retention window loads`() {
        store.save(messages, null, now = 0)
        assertNotNull(store.load(2, now = TimeUnit.DAYS.toMillis(1)))
    }

    @Test
    fun `zero retention disables and deletes`() {
        store.save(messages, null)
        assertNull(store.load(0))
        assertFalse(Files.exists(file))
    }

    @Test
    fun `corrupt file is set aside not thrown`() {
        Files.createDirectories(file.parent)
        Files.writeString(file, "{not json")
        assertNull(store.load(30))
        assertFalse(Files.exists(file))
        assertTrue(Files.exists(file.resolveSibling("abc123.json.corrupt")))
    }

    @Test
    fun `unknown version is set aside`() {
        Files.createDirectories(file.parent)
        Files.writeString(file, """{"version":99,"savedAt":1,"messages":[]}""")
        assertNull(store.load(30, now = 2))
        assertTrue(Files.exists(file.resolveSibling("abc123.json.corrupt")))
    }

    @Test
    fun `unknown role is set aside`() {
        Files.createDirectories(file.parent)
        Files.writeString(file, """{"version":1,"savedAt":1,"messages":[{"role":"ROBOT","content":"x"}]}""")
        assertNull(store.load(30, now = 2))
        assertTrue(Files.exists(file.resolveSibling("abc123.json.corrupt")))
    }

    @Test
    fun `delete removes file and tolerates absence`() {
        store.save(messages, null)
        store.delete()
        assertFalse(Files.exists(file))
        store.delete()
    }

    @Test
    fun `pruneExpired removes only stale json files`() {
        val old = ChatHistoryStore(ChatHistoryStore.pathFor(dir, "old"))
        old.save(messages, null)
        store.save(messages, null)
        val oldFile = old.file
        Files.setLastModifiedTime(oldFile, java.nio.file.attribute.FileTime.fromMillis(0))
        Files.writeString(oldFile.resolveSibling("keep.txt"), "x")
        Files.setLastModifiedTime(oldFile.resolveSibling("keep.txt"), java.nio.file.attribute.FileTime.fromMillis(0))
        ChatHistoryStore.pruneExpired(file.parent, 30)
        assertFalse(Files.exists(oldFile))
        assertTrue(Files.exists(file))
        assertTrue(Files.exists(oldFile.resolveSibling("keep.txt")))
    }

    @Test
    fun `pruneExpired with zero days clears everything and tolerates a missing dir`() {
        store.save(messages, null)
        Thread.sleep(5)
        ChatHistoryStore.pruneExpired(file.parent, 0)
        assertFalse(Files.exists(file))
        ChatHistoryStore.pruneExpired(dir.resolve("nope"), 30)
    }

    @Test
    fun `path lives under the plugin dir keyed by project`() {
        val p = ChatHistoryStore.pathFor(dir, "h")
        assertEquals(dir.resolve("aijb-assistant").resolve("history").resolve("h.json"), p)
    }

    // --- usage format ---

    @Test
    fun `usage plus sums tokens and costs`() {
        assertEquals(Usage(3, 3, 0.5), Usage(1, null, 0.25) + Usage(2, 3, 0.25))
        assertNull((Usage(1, 1) + Usage(1, 1)).costUsd)
        assertEquals(0.5, (Usage(1, 1) + Usage(1, 1, 0.5)).costUsd!!, 1e-9)
    }

    @Test
    fun `status shows done without usage`() {
        assertEquals("Done", UsageFormat.status(null, null))
    }

    @Test
    fun `status shows tokens and n-a cost`() {
        assertEquals("tokens: 5 in / ? out · cost n/a", UsageFormat.status(Usage(5, null), Usage(5, null)))
    }

    @Test
    fun `status shows reported cost and session totals once they differ`() {
        val req = Usage(10, 5, 0.0102346)
        assertEquals("tokens: 10 in / 5 out · cost $0.0102", UsageFormat.status(req, req))
        assertEquals(
            "tokens: 10 in / 5 out · cost $0.0102 · session: 30 in / 15 out · cost $0.0307",
            UsageFormat.status(req, Usage(30, 15, 0.0307)),
        )
        assertEquals("tokens: 1 in / 1 out · cost n/a", UsageFormat.status(Usage(1, 1), null))
    }

    // --- error hints ---

    @Test
    fun `every known code has a hint and unknown codes have none`() {
        val codes = listOf(
            "auth", "cli_not_found", "cli_exit", "cli_error", "model_unavailable", "rate_limited",
            "isolation_violation", "missing_api_key", "native_tools_unsupported",
            "invalid_upstream_response", "incomplete_stream", "protocol_error", "empty_turn",
            "context_limit", "truncated", "turn_limit", "provider_missing",
        )
        codes.forEach { assertNotNull(it, ErrorHints.hint(it)) }
        assertNull(ErrorHints.hint("nope"))
        assertNull(ErrorHints.hint(null))
    }

    @Test
    fun `format appends the hint only when one exists`() {
        assertTrue(ErrorHints.format("boom", "cli_not_found").startsWith("boom — "))
        assertTrue(ErrorHints.format("boom", "cli_not_found").contains("Settings"))
        assertEquals("boom", ErrorHints.format("boom", "weird"))
        assertEquals("boom", ErrorHints.format("boom", null))
    }
}

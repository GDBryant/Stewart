package com.adb.stewart

import com.adb.stewart.chat.ContextCompactor
import com.adb.stewart.chat.TokenEstimate
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.Usage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContextCompactorTest {

    private class CapturingProvider(
        private val events: List<ProviderEvent> = listOf(
            ProviderEvent.TextDelta("- earlier stuff"),
            ProviderEvent.Completed("stop", null),
        ),
    ) : ModelProvider {
        override val id = "fake"
        val requests = mutableListOf<ChatRequest>()
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            requests += request
            return flow { events.forEach { emit(it) } }
        }
    }

    private fun msgs(vararg rolesAndText: Pair<Role, String>) =
        rolesAndText.map { (r, t) -> ChatMessage(r, t) }

    private fun longThread(n: Int): List<ChatMessage> =
        (1..n).flatMap { i -> listOf(
            ChatMessage(Role.USER, "question $i " + "x".repeat(30)),
            ChatMessage(Role.ASSISTANT, "answer $i " + "y".repeat(30)),
        ) }

    private fun compact(
        provider: ModelProvider,
        messages: List<ChatMessage>,
        threshold: Int = 10,
        lastPromptTokens: Int? = null,
        keepRecent: Int = 4,
    ) = runBlocking {
        ContextCompactor(keepRecent).compactIfNeeded(provider, "m", messages, threshold, lastPromptTokens)
    }

    @Test
    fun `below threshold no provider call`() {
        val p = CapturingProvider()
        val messages = msgs(Role.USER to "hi")
        val r = compact(p, messages, threshold = 10_000)
        assertFalse(r.compacted)
        assertNull(r.error)
        assertEquals(messages, r.messages)
        assertTrue(p.requests.isEmpty())
        assertEquals(TokenEstimate.of(messages), r.beforeTokens)
    }

    @Test
    fun `above threshold summarises older and keeps tail`() {
        val p = CapturingProvider()
        val messages = longThread(6)
        val r = compact(p, messages, threshold = 10)
        assertTrue(r.compacted)
        assertNull(r.error)
        assertEquals(1, p.requests.size)
        val req = p.requests[0]
        assertEquals("m", req.model)
        assertTrue(req.tools.isEmpty())
        assertEquals(2, req.messages.size)
        assertEquals(Role.SYSTEM, req.messages[0].role)
        assertEquals(ContextCompactor.SUMMARY_PROMPT, req.messages[0].content)
        assertEquals(Role.USER, req.messages[1].role)
        assertTrue(req.messages[1].content.contains("[user] question 1"))
        assertTrue(req.messages[1].content.contains("[assistant] answer 4"))
        assertFalse(req.messages[1].content.contains("question 5"))
        assertEquals(4, r.messages.size)
        assertEquals(Role.USER, r.messages[0].role)
        assertTrue(r.messages[0].content.startsWith(
            ContextCompactor.SUMMARY_PREFIX + "\n- earlier stuff\n\n"))
        assertTrue(r.messages[0].content.contains("question 5"))
        assertEquals(messages.drop(9), r.messages.drop(1))
        assertTrue(r.afterTokens < r.beforeTokens)
        assertEquals(TokenEstimate.of(r.messages), r.afterTokens)
    }

    @Test
    fun `system prefix preserved and not rendered`() {
        val p = CapturingProvider()
        val messages = listOf(
            ChatMessage(Role.SYSTEM, "be terse"),
            ChatMessage(Role.SYSTEM, "more sys"),
        ) + longThread(6)
        val r = compact(p, messages, threshold = 10)
        assertTrue(r.compacted)
        assertEquals("be terse", r.messages[0].content)
        assertEquals("more sys", r.messages[1].content)
        assertEquals(Role.SYSTEM, r.messages[0].role)
        assertFalse(p.requests[0].messages[1].content.contains("be terse"))
    }

    @Test
    fun `kept tail starting with assistant gets separate summary message`() {
        val p = CapturingProvider()
        val messages = longThread(6)
        val r = compact(p, messages, threshold = 10, keepRecent = 3)
        assertTrue(r.compacted)
        assertEquals(Role.USER, r.messages[0].role)
        assertEquals(
            ContextCompactor.SUMMARY_PREFIX + "\n- earlier stuff",
            r.messages[0].content,
        )
        assertEquals(Role.ASSISTANT, r.messages[1].role)
    }

    @Test
    fun `first kept user message merges with summary`() {
        val p = CapturingProvider()
        val messages = longThread(6)
        val r = compact(p, messages, threshold = 10, keepRecent = 4)
        assertTrue(r.compacted)
        val merged = r.messages[0]
        assertEquals(Role.USER, merged.role)
        assertTrue(merged.content.startsWith(ContextCompactor.SUMMARY_PREFIX + "\n- earlier stuff\n\n"))
        assertTrue(merged.content.endsWith("question 5 " + "x".repeat(30)))
    }

    @Test
    fun `cut never splits tool calls from results`() {
        val p = CapturingProvider()
        val call = ToolCall("c1", "t", JsonObject(mapOf("a" to JsonPrimitive(1))))
        val messages = longThread(4) + listOf(
            ChatMessage(Role.ASSISTANT, "calling", toolCalls = listOf(call)),
            ChatMessage(Role.TOOL, "result output", toolCallId = "c1"),
        )
        val r = compact(p, messages, threshold = 10, keepRecent = 1)
        assertTrue(r.compacted)
        val kept = r.messages.drop(1)
        assertEquals(Role.ASSISTANT, kept[0].role)
        assertEquals(listOf(call), kept[0].toolCalls)
        assertEquals(Role.TOOL, kept[1].role)
        assertFalse(p.requests[0].messages[1].content.contains("[tool result c1]"))
    }

    @Test
    fun `tool call and result lines rendered`() {
        val p = CapturingProvider()
        val call = ToolCall("c9", "search", JsonObject(mapOf("q" to JsonPrimitive("x"))))
        val messages = listOf(
            ChatMessage(Role.USER, "go " + "x".repeat(30)),
            ChatMessage(Role.ASSISTANT, "using tool", toolCalls = listOf(call)),
            ChatMessage(Role.TOOL, "big output", toolCallId = "c9"),
            ChatMessage(Role.USER, "again " + "x".repeat(30)),
            ChatMessage(Role.ASSISTANT, "done " + "x".repeat(30)),
        )
        val r = compact(p, messages, threshold = 10, keepRecent = 2)
        assertTrue(r.compacted)
        val rendered = p.requests[0].messages[1].content
        assertTrue(rendered.contains("[assistant] using tool\n[tool call c9] search ${call.arguments}"))
        assertTrue(rendered.contains("[tool result c9] big output"))
    }

    @Test
    fun `tool result truncated at 2000 chars`() {
        val p = CapturingProvider()
        val big = "z".repeat(3000)
        val messages = listOf(
            ChatMessage(Role.USER, "go " + "x".repeat(30)),
            ChatMessage(Role.TOOL, big, toolCallId = "c1"),
            ChatMessage(Role.ASSISTANT, "ok " + "x".repeat(30)),
            ChatMessage(Role.USER, "more " + "x".repeat(30)),
            ChatMessage(Role.ASSISTANT, "done " + "x".repeat(30)),
        )
        val r = compact(p, messages, threshold = 10, keepRecent = 2)
        assertTrue(r.compacted)
        val rendered = p.requests[0].messages[1].content
        assertTrue(rendered.contains("[tool result c1] " + "z".repeat(2000) + "…[truncated]"))
        assertFalse(rendered.contains("z".repeat(2001)))
    }

    @Test
    fun `nothing to compact when body fits in keep recent`() {
        val p = CapturingProvider()
        val messages = longThread(2)
        val r = compact(p, messages, threshold = 1, keepRecent = 4)
        assertFalse(r.compacted)
        assertNull(r.error)
        assertEquals(messages, r.messages)
        assertTrue(p.requests.isEmpty())
    }

    @Test
    fun `single prior summary is not re-compacted`() {
        val p = CapturingProvider()
        val messages = listOf(
            ChatMessage(Role.USER, ContextCompactor.SUMMARY_PREFIX + "\n- old stuff " + "x".repeat(100)),
        ) + longThread(2)
        val r = compact(p, messages, threshold = 10, keepRecent = 4)
        assertFalse(r.compacted)
        assertNull(r.error)
        assertTrue(p.requests.isEmpty())
    }

    @Test
    fun `last prompt tokens triggers compaction`() {
        val p = CapturingProvider()
        val messages = longThread(6)
        val r = compact(p, messages, threshold = 100_000, lastPromptTokens = 100_000)
        assertTrue(r.compacted)
        assertEquals(1, p.requests.size)
    }

    @Test
    fun `provider failed event yields error and unchanged messages`() {
        val p = CapturingProvider(listOf(ProviderEvent.Failed("nope")))
        val messages = longThread(6)
        val r = compact(p, messages)
        assertFalse(r.compacted)
        assertEquals("nope", r.error)
        assertEquals(messages, r.messages)
    }

    @Test
    fun `stream without completed yields error`() {
        val p = CapturingProvider(listOf(ProviderEvent.TextDelta("partial")))
        val r = compact(p, longThread(6))
        assertFalse(r.compacted)
        assertEquals("summary stream ended before completion", r.error)
    }

    @Test
    fun `finish length yields truncated error`() {
        val p = CapturingProvider(listOf(
            ProviderEvent.TextDelta("x"), ProviderEvent.Completed("length", null)))
        val r = compact(p, longThread(6))
        assertFalse(r.compacted)
        assertEquals("summary truncated (length)", r.error)
    }

    @Test
    fun `finish content filter yields truncated error`() {
        val p = CapturingProvider(listOf(
            ProviderEvent.TextDelta("x"), ProviderEvent.Completed("content_filter", null)))
        val r = compact(p, longThread(6))
        assertFalse(r.compacted)
        assertEquals("summary truncated (content_filter)", r.error)
    }

    @Test
    fun `blank summary yields error`() {
        val p = CapturingProvider(listOf(
            ProviderEvent.TextDelta("   "), ProviderEvent.Completed("stop", null)))
        val r = compact(p, longThread(6))
        assertFalse(r.compacted)
        assertEquals("empty summary", r.error)
    }

    @Test
    fun `provider exception yields error`() {
        val p = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                throw RuntimeException("kaboom")
            }
        }
        val r = compact(p, longThread(6))
        assertFalse(r.compacted)
        assertEquals("kaboom", r.error)
    }

    @Test
    fun `provider exception without message yields fallback`() {
        val p = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                throw RuntimeException()
            }
        }
        val r = compact(p, longThread(6))
        assertEquals("summary failed", r.error)
    }

    @Test
    fun `cancellation propagates`() = runBlocking {
        val p = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                emit(ProviderEvent.TextDelta("x"))
                suspendCancellableCoroutine<Unit> { }
            }
        }
        val compactor = ContextCompactor(4)
        var propagated = false
        val job = launch {
            try {
                compactor.compactIfNeeded(p, "m", longThread(6), 10)
            } catch (e: CancellationException) {
                propagated = true
                throw e
            }
        }
        delay(50)
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        assertTrue(propagated)
    }

    private fun force(provider: ModelProvider, messages: List<ChatMessage>, focus: String?) = runBlocking {
        ContextCompactor(4).compact(provider, "m", messages, focus)
    }

    @Test
    fun `forced compaction ignores the threshold and uses the plain prompt without focus`() {
        val p = CapturingProvider()
        val r = force(p, longThread(3), null)
        assertTrue(r.compacted)
        assertNull(r.skipped)
        assertEquals(ContextCompactor.SUMMARY_PROMPT, p.requests.single().messages[0].content)
    }

    @Test
    fun `forced compaction appends the focus to the prompt`() {
        val p = CapturingProvider()
        val r = force(p, longThread(3), "  the db schema ")
        assertTrue(r.compacted)
        assertEquals(
            ContextCompactor.SUMMARY_PROMPT + " Focus especially on: the db schema",
            p.requests.single().messages[0].content,
        )
    }

    @Test
    fun `forced compaction with a blank focus uses the plain prompt`() {
        val p = CapturingProvider()
        force(p, longThread(3), "   ")
        assertEquals(ContextCompactor.SUMMARY_PROMPT, p.requests.single().messages[0].content)
    }

    @Test
    fun `forced compaction with nothing to compact says so`() {
        val p = CapturingProvider()
        val r = force(p, longThread(2), "x")
        assertFalse(r.compacted)
        assertNull(r.error)
        assertEquals(ContextCompactor.NOTHING_TO_COMPACT, r.skipped)
        assertTrue(p.requests.isEmpty())
    }

    @Test
    fun `forced compaction of an already compacted chat says so`() {
        val p = CapturingProvider()
        val messages = listOf(ChatMessage(Role.USER, ContextCompactor.SUMMARY_PREFIX + "\n- old")) + longThread(2)
        val r = force(p, messages, null)
        assertFalse(r.compacted)
        assertEquals(ContextCompactor.ALREADY_COMPACT, r.skipped)
        assertTrue(p.requests.isEmpty())
    }

    @Test
    fun `forced compaction provider error leaves messages unchanged`() {
        val messages = longThread(3)
        val r = force(CapturingProvider(listOf(ProviderEvent.Failed("nope"))), messages, null)
        assertFalse(r.compacted)
        assertEquals("nope", r.error)
        assertNull(r.skipped)
        assertEquals(messages, r.messages)
    }
}

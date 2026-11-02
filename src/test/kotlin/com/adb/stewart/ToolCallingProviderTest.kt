package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolChoice
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.Usage
import com.adb.stewart.shim.ToolPaths
import com.adb.stewart.shim.ToolCallingProvider
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolCallingProviderTest {

    private val spec = ToolSpec("read_file", "d", JsonObject(mapOf("type" to JsonPrimitive("object"), "properties" to JsonObject(emptyMap()))))

    private fun req(vararg ev: Pair<Role, String>, tools: List<ToolSpec> = listOf(spec), choice: ToolChoice = ToolChoice.Auto, model: String = "m") =
        ChatRequest(model, ev.map { ChatMessage(it.first, it.second) }, tools, choice)

    private class Fake(
        vararg val attempts: List<ProviderEvent>,
        val nativeSupport: Boolean = false,
    ) : ModelProvider {
        override val id = "fake"
        val requests = mutableListOf<ChatRequest>()
        var idx = 0
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun supportsNativeTools(model: String) = nativeSupport
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            requests.add(request)
            val evs = attempts.getOrElse(idx++) { attempts.last() }
            for (e in evs) emit(e)
        }
    }

    private fun collect(p: ModelProvider, r: ChatRequest): List<ProviderEvent> = runBlocking {
        p.chat(r).let { f -> mutableListOf<ProviderEvent>().also { l -> f.collect { l.add(it) } } }
    }

    @Test
    fun `shim parses textual call`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("sure <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call>"),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        val calls = events.filterIsInstance<ProviderEvent.ToolCalls>().single().calls
        assertEquals("read_file", calls[0].name)
        assertTrue(events.last() is ProviderEvent.Completed)
        assertEquals("tool_calls", (events.last() as ProviderEvent.Completed).finishReason)
        val sent = inner.requests[0]
        assertTrue(sent.tools.isEmpty())
        assertTrue(sent.messages[0].content.contains("# Tools"))
        assertTrue(sent.messages[0].role == Role.SYSTEM)
    }

    @Test
    fun `shim retry once on announce`() {
        val inner = Fake(
            listOf(ProviderEvent.TextDelta("Let me check."), ProviderEvent.Completed("stop", null)),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", Usage(1, 2))),
        )
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals(2, inner.requests.size)
        assertTrue(inner.requests[1].messages.last().content.contains("last reply ended without a tool call"))
        assertTrue(events.last() is ProviderEvent.Completed)
        assertEquals(Usage(1, 2), (events.last() as ProviderEvent.Completed).usage)
    }

    @Test
    fun `shim retry on required missing call`() {
        val inner = Fake(listOf(ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go", choice = ToolChoice.Required))
        assertEquals(2, inner.requests.size)
        assertEquals("tool_policy_violation", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `empty turn after retries`() {
        val inner = Fake(listOf(ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("empty_turn", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `policy violation parallel false`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call><tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>"),
            ProviderEvent.Completed("stop", null)))
        val r = req(Role.USER to "go").copy(parallelToolCalls = false)
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), r)
        assertEquals("tool_policy_violation", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `required without tools is invalid request`() {
        val inner = Fake()
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM),
            req(Role.USER to "go", tools = emptyList(), choice = ToolChoice.Function("missing")))
        assertEquals("invalid_request", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `no tools passthrough drops native calls`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("hi"),
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "t", "{}"))),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go", tools = emptyList()))
        assertTrue(events.none { it is ProviderEvent.NativeToolCalls })
        assertTrue(events.any { it == ProviderEvent.TextDelta("hi") })
    }

    @Test
    fun `length finish withholds calls`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.py\""),
            ProviderEvent.Completed("length", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertTrue(events.none { it is ProviderEvent.ToolCalls })
        assertTrue((events.last() as ProviderEvent.Completed).finishReason == "length")
    }

    @Test
    fun `inner failed propagates`() {
        val inner = Fake(listOf(ProviderEvent.Failed("nope")))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("nope", (events.last() as ProviderEvent.Failed).message)
    }

    @Test
    fun `stream without completed is incomplete`() {
        val inner = Fake(listOf(ProviderEvent.TextDelta("x")))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("incomplete_stream", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `events after completed are protocol error`() {
        val inner = Fake(listOf(
            ProviderEvent.Completed("stop", null), ProviderEvent.TextDelta("late")))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `native path requires support`() {
        val inner = Fake(listOf(ProviderEvent.Completed("stop", null)), nativeSupport = false)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertEquals("native_tools_unsupported", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `native path sends tools and repairs`() {
        val inner = Fake(listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "read_file", "{\"path\":\"a\"}"))),
            ProviderEvent.Completed("tool_calls", null)), nativeSupport = true)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertTrue(inner.requests[0].tools.isNotEmpty())
        val calls = events.filterIsInstance<ProviderEvent.ToolCalls>().single().calls
        assertEquals("read_file", calls[0].name)
    }

    @Test
    fun `native invalid call fails`() {
        val inner = Fake(listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "mystery", "{}"))),
            ProviderEvent.Completed("tool_calls", null)), nativeSupport = true)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertEquals("invalid_tool_call", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `quoted example produces no call`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("Use it like:\n```\n<tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>\n```"),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertTrue(events.none { it is ProviderEvent.ToolCalls })
    }

    @Test
    fun `toolpaths resolve`() {
        val native = Fake(nativeSupport = true)
        assertEquals(ToolPath.NATIVE, ToolPaths.resolve(native, "m", null))
        assertEquals(ToolPath.SHIM, ToolPaths.resolve(Fake(), "m", null))
        assertEquals(ToolPath.SHIM, ToolPaths.resolve(native, "m", ToolPath.SHIM))
        assertThrows(IllegalArgumentException::class.java) {
            ToolPaths.resolve(Fake(), "m", ToolPath.NATIVE)
        }
    }

    @Test
    fun `shim merges native and textual calls`() {
        val inner = Fake(listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "read_file", "{\"path\":\"a\"}"))),
            ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"b\"}}</tool_call>"),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        val calls = events.filterIsInstance<ProviderEvent.ToolCalls>().single().calls
        assertEquals(listOf("a", "b"), calls.map { it.arguments["path"]!!.let { p -> (p as kotlinx.serialization.json.JsonPrimitive).content } })
    }

    @Test
    fun `shim invalid native call fails`() {
        val inner = Fake(listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "mystery", "{}"))),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("invalid_tool_call", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `reasoning delta passes through`() {
        val inner = Fake(listOf(
            ProviderEvent.ReasoningDelta("hmm"),
            ProviderEvent.TextDelta("answer"),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertTrue(events.any { it == ProviderEvent.ReasoningDelta("hmm") })
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `native path passes text unparsed`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>"),
            ProviderEvent.Completed("stop", null)), nativeSupport = true)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertTrue(events.any { it is ProviderEvent.TextDelta })
        assertTrue(events.none { it is ProviderEvent.ToolCalls })
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `native length finish withholds`() {
        val inner = Fake(listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "read_file", "{}"))),
            ProviderEvent.Completed("length", null)), nativeSupport = true)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertTrue(events.none { it is ProviderEvent.ToolCalls })
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `native empty turn fails`() {
        val inner = Fake(listOf(ProviderEvent.Completed("stop", null)), nativeSupport = true)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertEquals("empty_turn", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `native path never retries or nudges`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("Let me check."),
            ProviderEvent.Completed("stop", null)), nativeSupport = true)
        collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertEquals(1, inner.requests.size)
        assertTrue(inner.requests[0].messages.none { it.content.contains("last reply ended") })
    }

    @Test
    fun `reasoning after completed is protocol error`() {
        val inner = Fake(listOf(
            ProviderEvent.Completed("stop", null), ProviderEvent.ReasoningDelta("late")))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `second native event after completed is protocol error`() {
        val inner = Fake(listOf(
            ProviderEvent.Completed("stop", null),
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "read_file", "{}")))))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `function choice retry then call`() {
        val inner = Fake(
            listOf(ProviderEvent.TextDelta("Let me check."), ProviderEvent.Completed("stop", null)),
            listOf(ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>"),
                   ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM),
            req(Role.USER to "go", choice = ToolChoice.Function("read_file")))
        assertEquals(2, inner.requests.size)
        assertTrue(events.any { it is ProviderEvent.ToolCalls })
    }

    @Test
    fun `shim retries only once`() {
        val inner = Fake(listOf(ProviderEvent.TextDelta("I'll check."), ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals(2, inner.requests.size)
        assertTrue(events.last() is ProviderEvent.Completed || events.last() is ProviderEvent.Failed)
    }

    @Test
    fun `inner ToolCalls event is protocol error`() {
        val inner = Fake(listOf(
            ProviderEvent.ToolCalls(listOf(ToolCall("x", "read_file", JsonObject(emptyMap())))),
            ProviderEvent.Completed("stop", null)), nativeSupport = true)
        val events = collect(ToolCallingProvider(inner, ToolPath.NATIVE), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `toolcalls after completed is protocol error`() {
        val inner = Fake(listOf(
            ProviderEvent.Completed("stop", null),
            ProviderEvent.ToolCalls(listOf(ToolCall("x", "read_file", JsonObject(emptyMap()))))))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `failed after completed is protocol error`() {
        val inner = Fake(listOf(ProviderEvent.Completed("stop", null), ProviderEvent.Failed("late")))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `second completed is protocol error`() {
        val inner = Fake(listOf(
            ProviderEvent.Completed("stop", null), ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertEquals("protocol_error", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `content filter withholds on shim`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{}"),
            ProviderEvent.Completed("content_filter", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertTrue(events.none { it is ProviderEvent.ToolCalls })
        assertEquals("content_filter", (events.last() as ProviderEvent.Completed).finishReason)
    }

    @Test
    fun `content filter held text emitted`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("plain prefix"),
            ProviderEvent.Completed("content_filter", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertTrue(events.last() is ProviderEvent.Completed)
        assertTrue((events.last() as ProviderEvent.Completed).finishReason == "content_filter")
    }

    @Test
    fun `reasoning in parse result emitted`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("<think>ponder</think>answer"),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM), req(Role.USER to "go"))
        assertTrue(events.any { it == ProviderEvent.ReasoningDelta("ponder") })
    }

    @Test
    fun `shim required with calls succeeds`() {
        val inner = Fake(listOf(
            ProviderEvent.TextDelta("<tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>"),
            ProviderEvent.Completed("stop", null)))
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM),
            req(Role.USER to "go", choice = ToolChoice.Required))
        assertTrue(events.any { it is ProviderEvent.ToolCalls })
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `shim empty on second attempt yields empty turn`() {
        var n = 0
        val inner = object : ModelProvider {
            override val id = "f"
            override suspend fun listModels() = emptyList<ModelInfo>()
            override fun chat(request: ChatRequest) = kotlinx.coroutines.flow.flow<ProviderEvent> {
                n++
                emit(ProviderEvent.Completed("stop", null))
            }
        }
        val events = collect(ToolCallingProvider(inner, ToolPath.SHIM),
            req(Role.USER to "g"))
        assertEquals(2, n)
        assertEquals("empty_turn", (events.last() as ProviderEvent.Failed).code)
    }
}

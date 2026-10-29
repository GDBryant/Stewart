package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolChoice
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.provider.aif.AifProvider
import com.aijb.assistant.provider.aif.AifUrls
import com.aijb.assistant.shim.ToolCallingProvider
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AifProviderTest {

    private lateinit var server: HttpServer
    private var body: String = ""

    private fun provider(models: List<String> = listOf("m"), key: String? = "test-api-key") =
        AifProvider("http://127.0.0.1:${server.address.port}/api/proxy/v1", models, { key },
            java.net.http.HttpClient.newHttpClient())

    @Before fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.start()
    }

    @After fun tearDown() { server.stop(0) }

    private fun handler(response: String, code: Int = 200) {
        server.createContext("/api/proxy/v1/chat/completions") { ex ->
            capturedAuth = ex.requestHeaders.getFirst("Authorization")
            body = ex.requestBody.bufferedReader().readText()
            ex.responseHeaders.add("Content-Type", "text/event-stream")
            ex.sendResponseHeaders(code, response.toByteArray().size.toLong())
            ex.responseBody.use { it.write(response.toByteArray()) }
        }
    }

    private fun req() = ChatRequest("m", listOf(ChatMessage(Role.USER, "hi")))

    private fun collect(p: AifProvider, r: ChatRequest = req()) = runBlocking {
        mutableListOf<ProviderEvent>().also { l -> p.chat(r).collect { l.add(it) } }
    }

    @Test
    fun `url joining`() {
        assertEquals("http://x/chat/completions", AifUrls.chatCompletions("http://x/"))
        assertEquals("http://x/v1/chat/completions", AifUrls.chatCompletions("http://x/v1"))
        assertEquals("http://x/chat/completions", AifUrls.chatCompletions("http://x/chat/completions"))
        assertThrows(IllegalArgumentException::class.java) { AifUrls.chatCompletions("ftp://x") }
        assertThrows(IllegalArgumentException::class.java) { AifUrls.chatCompletions("http://x/v1?y=1") }
    }

    @Test
    fun `streams deltas and done`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n" +
            "data: {\"choices\":[{\"delta\":{\"content\":\"b\"},\"finish_reason\":\"stop\"}]}\n" +
            "data: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\ndata: [DONE]\n")
        val events = collect(provider())
        assertEquals(listOf(ProviderEvent.TextDelta("a"), ProviderEvent.TextDelta("b")), events.subList(0, 2))
        val done = events.last() as ProviderEvent.Completed
        assertEquals("stop", done.finishReason)
        assertEquals(3, done.usage?.promptTokens)
    }

    @Test
    fun `request shape`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val spec = ToolSpec("t", "d", JsonObject(emptyMap()))
        collect(provider(), req().copy(tools = listOf(spec), toolChoice = ToolChoice.Required, parallelToolCalls = true))
        val sent = Json.parseToJsonElement(body)
        assertEquals("m", sent.jsonPrimitiveLet("model"))
        assertEquals(true, sent.jsonPrimitiveLet("stream"))
        assertEquals("required", sent.jsonPrimitiveLet("tool_choice"))
        assertTrue(body.contains("\"tools\""))
        assertTrue(body.contains("\"parallel_tool_calls\":true"))
        assertEquals("Bearer test-api-key", capturedAuth)
    }

    private var capturedAuth: String? = null

    @Test
    fun `sse tool call deltas become native calls`() = runBlocking {
        server.createContext("/api/proxy/v1/chat/completions") { ex ->
            body = ex.requestBody.bufferedReader().readText()
            val r = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_\"}}]}}]}\n" +
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"file\",\"arguments\":\"{}\"}}]}}]}\n" +
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\n"
            ex.sendResponseHeaders(200, r.toByteArray().size.toLong())
            ex.responseBody.use { it.write(r.toByteArray()) }
        }
        val events = collect(provider())
        val native = events.filterIsInstance<ProviderEvent.NativeToolCalls>().single()
        assertEquals("read_file", native.calls[0].name)
        assertEquals("c1", native.calls[0].id)
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `native route completes with tool calls`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}]}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\n")
        val aif = AifProvider("http://127.0.0.1:${server.address.port}/api/proxy/v1",
            listOf("m"), { "k" }, java.net.http.HttpClient.newHttpClient(),
            nativeToolsConfirmed = { true })
        val spec = ToolSpec("read_file", "d", JsonObject(mapOf("type" to JsonPrimitive("object"),
            "properties" to JsonObject(emptyMap()))))
        val events = mutableListOf<ProviderEvent>()
        ToolCallingProvider(aif, com.aijb.assistant.provider.ToolPath.NATIVE)
            .chat(req().copy(tools = listOf(spec))).collect { events.add(it) }
        val calls = events.filterIsInstance<ProviderEvent.ToolCalls>().single().calls
        assertEquals("read_file", calls[0].name)
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `native route malformed call fails`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"mystery\",\"arguments\":\"{}\"}}]}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\n")
        val aif = AifProvider("http://127.0.0.1:${server.address.port}/api/proxy/v1",
            listOf("m"), { "k" }, java.net.http.HttpClient.newHttpClient(),
            nativeToolsConfirmed = { true })
        val spec = ToolSpec("read_file", "d", JsonObject(mapOf("type" to JsonPrimitive("object"),
            "properties" to JsonObject(emptyMap()))))
        val events = mutableListOf<ProviderEvent>()
        ToolCallingProvider(aif, com.aijb.assistant.provider.ToolPath.NATIVE)
            .chat(req().copy(tools = listOf(spec))).collect { events.add(it) }
        val last = events.last()
        assertTrue(last is ProviderEvent.Failed && last.code == "invalid_tool_call")
    }

    @Test
    fun `native route denied without confirmed support`() = runBlocking {
        val aif = AifProvider("http://127.0.0.1:${server.address.port}/api/proxy/v1",
            listOf("m"), { "k" }, java.net.http.HttpClient.newHttpClient())
        val spec = ToolSpec("read_file", "d", JsonObject(mapOf("type" to JsonPrimitive("object"),
            "properties" to JsonObject(emptyMap()))))
        val events = mutableListOf<ProviderEvent>()
        ToolCallingProvider(aif, com.aijb.assistant.provider.ToolPath.NATIVE)
            .chat(req().copy(tools = listOf(spec))).collect { events.add(it) }
        val last = events.last()
        assertTrue(last is ProviderEvent.Failed && last.code == "native_tools_unsupported")
    }

    @Test
    fun `reasoning content forwarded`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val events = collect(provider())
        assertTrue(events.any { it == ProviderEvent.ReasoningDelta("think") })
    }

    @Test
    fun `non 2xx fails with server message`() = runBlocking {
        handler("{\"error\":{\"message\":\"bad key\"}}", 401)
        val events = collect(provider())
        assertEquals(listOf(ProviderEvent.Failed("bad key")), events)
    }

    @Test
    fun `missing key fails without request`() = runBlocking {
        val events = collect(provider(key = ""))
        assertEquals("missing_api_key", (events.single() as ProviderEvent.Failed).code)
    }

    @Test
    fun `error event in stream`() = runBlocking {
        handler("data: {\"error\":\"upstream broke\"}\n")
        val events = collect(provider())
        assertTrue((events.single() as ProviderEvent.Failed).message.contains("upstream broke"))
    }

    @Test
    fun `no finish reason fails`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\ndata: [DONE]\n")
        val events = collect(provider())
        assertEquals("incomplete_stream", (events.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `list models returns configured`() = runBlocking {
        assertEquals(listOf("a", "b"), provider(listOf("a", "b")).listModels().map { it.ref.modelId })
    }

    @Test
    fun `cancellation aborts promptly`() {
        val release = CountDownLatch(1)
        server.createContext("/api/proxy/v1/chat/completions") { ex ->
            try {
                ex.sendResponseHeaders(200, -1)
                release.await(30, TimeUnit.SECONDS)
            } finally { ex.close() }
        }
        try {
            val job: Job
            runBlocking {
                job = launch { provider().chat(req()).collect { } }
            }
            Thread.sleep(300)
            runBlocking {
                job.cancel()
                withTimeout(2000) { job.join() }
            }
            assertTrue(job.isCompleted)
        } finally {
            release.countDown()
        }
    }

    private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveLet(k: String) =
        (this as JsonObject)[k]?.jsonPrimitive?.content?.let { if (it == "true") true else it }

    @Test
    fun `malformed sse variants fail`() = runBlocking {
        for (payload in listOf(
            "data: not-json\n",
            "data: [1]\n",
            "data: {\"choices\":{\"x\":1}}\n",
            "data: {\"choices\":[{\"delta\":5}]}\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":5}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":5}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":{\"x\":1}}}]}\n",
        )) {
            val h = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            h.createContext("/api/proxy/v1/chat/completions") { ex ->
                ex.sendResponseHeaders(200, payload.toByteArray().size.toLong())
                ex.responseBody.use { it.write(payload.toByteArray()) }
            }
            h.start()
            try {
                val p = AifProvider("http://127.0.0.1:${h.address.port}/api/proxy/v1", listOf("m"), { "k" },
                    java.net.http.HttpClient.newHttpClient())
                val events = collect(p)
                assertTrue(payload, events.last() is ProviderEvent.Failed)
            } finally { h.stop(0) }
        }
    }

    @Test
    fun `assistant tool calls and tool role serialize`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val msg = ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
            ToolCall("c1", "t", kotlinx.serialization.json.JsonObject(mapOf("a" to kotlinx.serialization.json.JsonPrimitive(1))))))
        collect(provider(), req().copy(messages = listOf(
            ChatMessage(Role.SYSTEM, "s"), msg,
            ChatMessage(Role.TOOL, "res", toolCallId = "c1"))))
        assertTrue(body.contains("\"tool_calls\""))
        assertTrue(body.contains("\"tool_call_id\":\"c1\""))
        assertTrue(body.contains("\"role\":\"tool\""))
    }

    @Test
    fun `empty content and non data lines skipped`() = runBlocking {
        handler(": comment\ndata: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val events = collect(provider())
        assertTrue(events.none { it is ProviderEvent.TextDelta })
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `request without tools omits tool keys`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        collect(provider())
        assertTrue(!body.contains("\"tools\""))
        assertTrue(!body.contains("tool_choice"))
    }

    @Test
    fun `connection failure is failed not exception`() = runBlocking {
        val p = AifProvider("http://127.0.0.1:1/api/proxy/v1", listOf("m"), { "k" },
            java.net.http.HttpClient.newHttpClient())
        val events = collect(p)
        assertTrue(events.last() is ProviderEvent.Failed)
        assertTrue((events.last() as ProviderEvent.Failed).message.isNotEmpty())
    }

    @Test
    fun `error object with nested message`() = runBlocking {
        handler("data: {\"error\":{\"message\":\"quota exceeded\"}}\n")
        val events = collect(provider())
        assertEquals("quota exceeded", (events.last() as ProviderEvent.Failed).message)
    }

    @Test
    fun `null fields treated as absent`() = runBlocking {
        handler("data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n" +
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}]},\"finish_reason\":null}]}\n" +
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n" +
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":1}}\ndata: [DONE]\n")
        val events = collect(provider())
        val native = events.filterIsInstance<ProviderEvent.NativeToolCalls>().single()
        assertEquals("read_file", native.calls[0].name)
        assertEquals("{\"path\":\"a\"}", native.calls[0].arguments)
        val done = events.last() as ProviderEvent.Completed
        assertEquals("tool_calls", done.finishReason)
        assertEquals(5, done.usage?.promptTokens)
    }

    @Test
    fun `plain text stream with null finish reasons`() = runBlocking {
        handler("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi \"},\"finish_reason\":null}]}\n" +
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"there\",\"tool_calls\":null,\"reasoning_content\":null},\"finish_reason\":null}]}\n" +
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val events = collect(provider())
        assertEquals(listOf(ProviderEvent.TextDelta("hi "), ProviderEvent.TextDelta("there")),
            events.filterIsInstance<ProviderEvent.TextDelta>())
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `api key redacted from error messages`() = runBlocking {
        var n = 0
        server.createContext("/api/proxy/v1/chat/completions") { ex ->
            body = ex.requestBody.bufferedReader().readText()
            val (r, code) = if (n++ == 0) {
                "oops, key was secret-key-123 somewhere" to 500
            } else {
                "{\"error\":{\"message\":\"bad: secret-key-123\"}}" to 401
            }
            ex.sendResponseHeaders(code, r.toByteArray().size.toLong())
            ex.responseBody.use { it.write(r.toByteArray()) }
        }
        val events = collect(provider(key = "secret-key-123"))
        assertEquals("oops, key was *** somewhere", (events.last() as ProviderEvent.Failed).message)
        val e2 = collect(provider(key = "secret-key-123"))
        assertEquals("bad: ***", (e2.last() as ProviderEvent.Failed).message)
    }

    @Test
    fun `tool choice function serializes`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val spec = ToolSpec("read_file", "d", JsonObject(emptyMap()))
        collect(provider(), req().copy(tools = listOf(spec), toolChoice = ToolChoice.Function("read_file")))
        assertTrue(body.contains("\"function\":{\"name\":\"read_file\"}"))
    }

    @Test
    fun `tool choice none omits tools`() = runBlocking {
        handler("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n")
        val spec = ToolSpec("read_file", "d", JsonObject(emptyMap()))
        collect(provider(), req().copy(tools = emptyList(), toolChoice = ToolChoice.None))
        assertTrue(!body.contains("\"tools\""))
    }
}

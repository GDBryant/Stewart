package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ollama.OllamaProvider
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OllamaProviderTest {

    private val testJson = kotlinx.serialization.json.Json
    private lateinit var server: HttpServer
    private lateinit var provider: OllamaProvider

    @Before
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.start()
        provider = OllamaProvider("http://127.0.0.1:${server.address.port}")
    }

    @After
    fun tearDown() {
        server.stop(0)
    }

    private fun request() = ChatRequest("m", listOf(ChatMessage(Role.USER, "hi")))

    @Test
    fun `streams deltas then done`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"message":{"content":"a"},"done":false}""" + "\n" +
                """{"message":{"content":"b"},"done":false}""" + "\n" +
                """{"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":2}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertEquals(listOf(ProviderEvent.TextDelta("a"), ProviderEvent.TextDelta("b")), events.subList(0, 2))
        val done = events.last() as ProviderEvent.Completed
        assertEquals("stop", done.finishReason)
        assertEquals(3, done.usage?.promptTokens)
        assertEquals(2, done.usage?.completionTokens)
    }

    @Test
    fun `non 2xx becomes failed`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"error":"model not found"}"""
            ex.sendResponseHeaders(404, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertEquals(listOf(ProviderEvent.Failed("model not found")), events)
    }

    @Test
    fun `stream without done becomes failed`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"message":{"content":"x"},"done":false}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertTrue(events.last() is ProviderEvent.Failed)
        assertEquals("stream ended before completion", (events.last() as ProviderEvent.Failed).message)
    }

    @Test
    fun `cancellation aborts promptly`() {
        val release = CountDownLatch(1)
        server.createContext("/api/chat") { ex ->
            try {
                ex.sendResponseHeaders(200, -1)
                ex.responseBody.write("""{"message":{"content":"x"},"done":false}""".toByteArray() + "\n".toByteArray())
                ex.responseBody.flush()
                release.await(30, TimeUnit.SECONDS)
            } finally {
                ex.close()
            }
        }
        val events = mutableListOf<ProviderEvent>()
        val job: Job
        try {
            runBlocking {
                job = launch {
                    provider.chat(request()).collect { events.add(it) }
                }
            }
            Thread.sleep(500)
            runBlocking {
                job.cancel()
                withTimeout(2000) { job.join() }
            }
            assertTrue(job.isCompleted)
            assertTrue(events.none { it is ProviderEvent.Completed })
        } finally {
            release.countDown()
        }
    }

    @Test
    fun `blank and empty-content lines tolerated`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = "\n" +
                """{"message":{"content":""},"done":false}""" + "\n\n" +
                """{"message":{"content":"x"},"done":false}""" + "\n" +
                """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertEquals(2, events.size)
        assertEquals(ProviderEvent.TextDelta("x"), events[0])
        assertTrue(events[1] is ProviderEvent.Completed)
    }

    @Test
    fun `cancel while connecting aborts promptly`() {
        val release = CountDownLatch(1)
        server.createContext("/api/chat") { ex ->
            try {
                release.await(30, TimeUnit.SECONDS)
                ex.sendResponseHeaders(200, 0)
            } finally {
                ex.close()
            }
        }
        try {
            val job: Job
            runBlocking {
                job = launch {
                    provider.chat(request()).collect { }
                }
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

    @Test
    fun `non 2xx with plain text body reports body`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = "proxy exploded"
            ex.sendResponseHeaders(502, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertEquals(listOf(ProviderEvent.Failed("proxy exploded")), events)
    }

    @Test
    fun `error line then done yields only failed`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"error":"boom"}""" + "\n" +
                """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertEquals(listOf(ProviderEvent.Failed("boom")), events)
    }

    @Test
    fun `malformed line then done yields only failed`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = "{bad\n" +
                """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertEquals(1, events.size)
        assertTrue(events.single() is ProviderEvent.Failed)
    }

    @Test
    fun `listModels non-2xx throws IOException with server message`() {
        server.createContext("/api/tags") { ex ->
            val body = """{"error":"upstream down"}"""
            ex.sendResponseHeaders(500, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val e = org.junit.Assert.assertThrows(java.io.IOException::class.java) {
            runBlocking { provider.listModels() }
        }
        assertEquals("upstream down", e.message)
    }

    @Test
    fun `listModels empty and missing models yields empty list`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        assertEquals(emptyList<Any>(), provider.listModels())
        server.removeContext("/api/tags")
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"size":1},{"name":"c:latest"}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        assertEquals(listOf("c:latest"), provider.listModels().map { it.ref.modelId })
        server.removeContext("/api/tags")
        server.createContext("/api/tags") { ex ->
            val body = """{}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        assertEquals(emptyList<Any>(), provider.listModels())
    }

    @Test
    fun `connection refused fails chat and throws for listModels`() {
        val dead = OllamaProvider("http://127.0.0.1:${server.address.port + 1}")
        runBlocking {
            val events = mutableListOf<ProviderEvent>()
            dead.chat(request()).collect { events.add(it) }
            assertEquals(1, events.size)
            assertTrue(events.single() is ProviderEvent.Failed)
        }
        org.junit.Assert.assertThrows(Exception::class.java) {
            runBlocking { dead.listModels() }
        }
    }

    @Test
    fun `tags endpoint maps model names`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"a:latest"},{"name":"b:latest"}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val models = provider.listModels()
        assertEquals(listOf("a:latest", "b:latest"), models.map { it.ref.modelId })
        assertEquals("ollama", models.first().ref.providerId)
    }

    @Test
    fun `done without reason or usage fields`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = "{\"message\":{\"content\":\"x\"},\"done\":false}\n{\"done\":true}\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertTrue(events.last() is ProviderEvent.Completed)
        assertEquals("stop", (events.last() as ProviderEvent.Completed).finishReason)
    }

    @Test
    fun `lines without message and non-string fields tolerated`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = "{\"done\":false}\n{\"message\":{}}\n{\"done\":true,\"done_reason\":\"stop\"}\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `ndjson edge cases`() {
        org.junit.Assert.assertNull(com.adb.stewart.provider.ollama.OllamaNdjson.parseLine("{}"))
        org.junit.Assert.assertNull(com.adb.stewart.provider.ollama.OllamaNdjson.parseLine("""{"message":{"content":""},"done":false}"""))
        val e = com.adb.stewart.provider.ollama.OllamaNdjson.parseLine("""{"error":42}""")
        assertTrue(e is ProviderEvent.Failed)
        org.junit.Assert.assertNull(com.adb.stewart.provider.ollama.OllamaNdjson.parseLine("""{"model":"m"}"""))
        val c = com.adb.stewart.provider.ollama.OllamaNdjson.parseLine("""{"message":{"content":"y"},"done":false}""")
        assertEquals(ProviderEvent.TextDelta("y"), c)
        val d = com.adb.stewart.provider.ollama.OllamaNdjson.parseLine("""{"done":true,"prompt_eval_count":1,"eval_count":2}""")
        assertTrue(d is ProviderEvent.Completed)
        assertEquals(1, (d as ProviderEvent.Completed).usage?.promptTokens)
        assertEquals(2, d.usage?.completionTokens)
    }

    @Test
    fun `tools sent in request when offered`() = runBlocking {
        var sentBody = ""
        server.createContext("/api/chat") { ex ->
            sentBody = ex.requestBody.readBytes().decodeToString()
            val body = """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val spec = com.adb.stewart.provider.ToolSpec(
            "read_file", "read", kotlinx.serialization.json.JsonObject(emptyMap()))
        provider.chat(ChatRequest("m", listOf(ChatMessage(Role.USER, "hi")), tools = listOf(spec)))
            .collect { }
        val root = testJson.parseToJsonElement(sentBody).jsonObject
        val tools = root["tools"]!!.jsonArray
        assertEquals(1, tools.size)
        assertEquals("function", tools[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("read_file", tools[0].jsonObject["function"]!!.jsonObject["name"]!!.jsonPrimitive.content)
        org.junit.Assert.assertFalse(root.containsKey("tool_choice"))
    }

    @Test
    fun `tools absent when not offered`() = runBlocking {
        var sentBody = ""
        server.createContext("/api/chat") { ex ->
            sentBody = ex.requestBody.readBytes().decodeToString()
            val body = """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        provider.chat(request()).collect { }
        org.junit.Assert.assertFalse(
            testJson.parseToJsonElement(sentBody)
                .jsonObject.containsKey("tools"))
    }

    @Test
    fun `assistant tool calls and tool results encoded`() = runBlocking {
        var sentBody = ""
        server.createContext("/api/chat") { ex ->
            sentBody = ex.requestBody.readBytes().decodeToString()
            val body = """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val messages = listOf(
            ChatMessage(Role.USER, "hi"),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                com.adb.stewart.provider.ToolCall("call_0", "read_file",
                    kotlinx.serialization.json.JsonObject(mapOf("path" to kotlinx.serialization.json.JsonPrimitive("a")))))),
            ChatMessage(Role.TOOL, "contents", toolCallId = "call_0"),
        )
        provider.chat(ChatRequest("m", messages)).collect { }
        val msgs = testJson.parseToJsonElement(sentBody)
            .jsonObject["messages"]!!.jsonArray
        val assistant = msgs[1].jsonObject
        val fn = assistant["tool_calls"]!!.jsonArray[0].jsonObject["function"]!!.jsonObject
        assertEquals("read_file", fn["name"]!!.jsonPrimitive.content)
        assertEquals("a", fn["arguments"]!!.jsonObject["path"]!!.jsonPrimitive.content)
        val tool = msgs[2].jsonObject
        assertEquals("tool", tool["role"]!!.jsonPrimitive.content)
        assertEquals("call_0", tool["tool_call_id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `400 does not support tools yields native unsupported code`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"error":"qwen does not support tools"}"""
            ex.sendResponseHeaders(400, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        val f = events.single() as ProviderEvent.Failed
        assertEquals("native_tools_unsupported", f.code)
        assertEquals("qwen does not support tools", f.message)
    }

    @Test
    fun `400 without tools message has no code`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"error":"bad request"}"""
            ex.sendResponseHeaders(400, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        val f = events.single() as ProviderEvent.Failed
        org.junit.Assert.assertNull(f.code)
    }

    @Test
    fun `native tool call line streams as NativeToolCalls`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"a"}}}]},"done":false}""" + "\n" +
                """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        val calls = (events[0] as ProviderEvent.NativeToolCalls).calls
        assertEquals("read_file", calls[0].name)
        assertTrue(events.last() is ProviderEvent.Completed)
    }

    @Test
    fun `listModels fills capability cache from tags`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"tooly","capabilities":["completion","tools"]},{"name":"plain","capabilities":["completion"]}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        provider.listModels()
        assertTrue(provider.supportsNativeTools("tooly"))
        org.junit.Assert.assertFalse(provider.supportsNativeTools("plain"))
        org.junit.Assert.assertFalse(provider.supportsNativeTools("never-listed"))
    }

    @Test
    fun `listModels probes api show when capabilities missing`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"old"}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        server.createContext("/api/show") { ex ->
            val req = ex.requestBody.readBytes().decodeToString()
            assertTrue(req.contains("old"))
            val body = """{"capabilities":["completion","tools"]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        provider.listModels()
        assertTrue(provider.supportsNativeTools("old"))
    }

    @Test
    fun `refresh drops removed and downgraded models`() = runBlocking {
        var tagsBody = """{"models":[{"name":"tooly","capabilities":["tools"]},{"name":"gone","capabilities":["tools"]}]}"""
        server.createContext("/api/tags") { ex ->
            ex.sendResponseHeaders(200, tagsBody.toByteArray().size.toLong())
            ex.responseBody.use { it.write(tagsBody.toByteArray()) }
        }
        provider.listModels()
        assertTrue(provider.supportsNativeTools("tooly"))
        assertTrue(provider.supportsNativeTools("gone"))
        tagsBody = """{"models":[{"name":"tooly","capabilities":[]}]}"""
        provider.listModels()
        assertTrue(!provider.supportsNativeTools("tooly"))
        assertTrue(!provider.supportsNativeTools("gone"))
    }

    @Test
    fun `malformed tags capabilities still lists models and probes`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"m1","capabilities":"oops"},{"name":"m2","capabilities":["tools"]}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        server.createContext("/api/show") { ex ->
            val req = ex.requestBody.readBytes().decodeToString()
            val body = """{"capabilities":["completion","tools"]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val models = provider.listModels()
        assertEquals(2, models.size)
        assertTrue(provider.supportsNativeTools("m2"))
    }

    @Test
    fun `tool name derived per call id in tool messages`() = runBlocking {
        var sentBody = ""
        server.createContext("/api/chat") { ex ->
            sentBody = ex.requestBody.readBytes().decodeToString()
            val body = """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val messages = listOf(
            ChatMessage(Role.USER, "hi"),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                com.adb.stewart.provider.ToolCall("idA", "read_file", kotlinx.serialization.json.JsonObject(emptyMap())),
                com.adb.stewart.provider.ToolCall("idB", "find_files", kotlinx.serialization.json.JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "rA", toolCallId = "idA"),
            ChatMessage(Role.TOOL, "rB", toolCallId = "idB"),
        )
        provider.chat(ChatRequest("m", messages)).collect { }
        val msgs = testJson.parseToJsonElement(sentBody).jsonObject["messages"]!!.jsonArray
        assertEquals("read_file", msgs[2].jsonObject["tool_name"]!!.jsonPrimitive.content)
        assertEquals("find_files", msgs[3].jsonObject["tool_name"]!!.jsonPrimitive.content)
        assertEquals("idA", msgs[2].jsonObject["tool_call_id"]!!.jsonPrimitive.content)
        assertEquals("idB", msgs[3].jsonObject["tool_call_id"]!!.jsonPrimitive.content)
        val call = msgs[1].jsonObject["tool_calls"]!!.jsonArray[0].jsonObject
        assertEquals("idA", call["id"]!!.jsonPrimitive.content)
        assertEquals("function", call["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `synthesised call ids are unique across lines`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"message":{"tool_calls":[{"function":{"name":"a","arguments":{}}}]},"done":false}""" + "\n" +
                """{"message":{"tool_calls":[{"function":{"name":"b","arguments":{}}}]},"done":true,"done_reason":"tool_calls"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        val calls = events.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(2, calls.size)
        assertTrue(calls[0].id != calls[1].id)
        assertTrue(calls[0].id!!.startsWith("call_"))
    }

    @Test
    fun `duplicate call id across lines fails closed`() = runBlocking {
        var chats = 0
        server.createContext("/api/chat") { ex ->
            chats++
            val body = if (chats == 1) {
                """{"message":{"tool_calls":[{"id":"dup","function":{"name":"a","arguments":{}}}]},"done":false}""" + "\n" +
                    """{"message":{"tool_calls":[{"id":"dup","function":{"name":"b","arguments":{}}}]},"done":false}""" + "\n"
            } else """{"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        val native = events.filterIsInstance<ProviderEvent.NativeToolCalls>()
        assertEquals(1, native.size)
        val f = events.last() as ProviderEvent.Failed
        assertEquals("invalid_upstream_response", f.code)
        assertTrue(events.none { it is ProviderEvent.Completed })
    }

    @Test
    fun `duplicate plus fresh call on second line fails closed`() = runBlocking {
        server.createContext("/api/chat") { ex ->
            val body = """{"message":{"tool_calls":[{"id":"dup","function":{"name":"a","arguments":{}}}]},"done":false}""" + "\n" +
                """{"message":{"tool_calls":[{"id":"dup","function":{"name":"b","arguments":{}}},{"id":"fresh","function":{"name":"c","arguments":{}}}]},"done":true,"done_reason":"tool_calls"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val events = mutableListOf<ProviderEvent>()
        provider.chat(request()).collect { events.add(it) }
        val native = events.filterIsInstance<ProviderEvent.NativeToolCalls>()
        assertEquals(1, native.size)
        assertEquals(listOf("dup"), native[0].calls.map { it.id })
        val f = events.last() as ProviderEvent.Failed
        assertEquals("invalid_upstream_response", f.code)
        assertTrue(events.none { it is ProviderEvent.Completed })
    }

    @Test
    fun `malformed show response leaves capability false`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"m"}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        server.createContext("/api/show") { ex ->
            val body = "not json at all"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val models = provider.listModels()
        assertEquals(1, models.size)
        assertTrue(!provider.supportsNativeTools("m"))
    }

    @Test
    fun `show probe cancellation does not publish capability`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"m"}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val reached = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        server.createContext("/api/show") { ex ->
            reached.countDown()
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            val body = """{"capabilities":["tools"]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val job = launch(kotlinx.coroutines.Dispatchers.Default) { provider.listModels() }
        assertTrue(reached.await(5, java.util.concurrent.TimeUnit.SECONDS))
        try {
            withTimeout(2000) { job.cancelAndJoin() }
        } finally {
            release.countDown()
        }
        assertTrue(job.isCancelled)
        assertTrue(!provider.supportsNativeTools("m"))
    }

    @Test
    fun `api show failure leaves capability unknown`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"old"}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        server.createContext("/api/show") { ex ->
            val body = """{"error":"nope"}"""
            ex.sendResponseHeaders(500, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        provider.listModels()
        org.junit.Assert.assertFalse(provider.supportsNativeTools("old"))
    }

    @Test
    fun `native path with function choice`() = runBlocking {
        var sent: ChatRequest? = null
        val inner = object : com.adb.stewart.provider.ModelProvider {
            override val id = "n"
            override suspend fun listModels() = emptyList<com.adb.stewart.provider.ModelInfo>()
            override fun supportsNativeTools(model: String) = true
            override fun chat(request: ChatRequest) = kotlinx.coroutines.flow.flow<ProviderEvent> {
                sent = request
                emit(ProviderEvent.Completed("stop", null))
            }
        }
        val spec = com.adb.stewart.provider.ToolSpec("read_file", "d", kotlinx.serialization.json.JsonObject(emptyMap()))
        val events = mutableListOf<ProviderEvent>()
        com.adb.stewart.shim.ToolCallingProvider(inner, com.adb.stewart.provider.ToolPath.NATIVE).chat(
            ChatRequest("m", listOf(ChatMessage(Role.USER, "g")),
                listOf(spec), com.adb.stewart.provider.ToolChoice.Function("read_file"))).collect { events.add(it) }
        assertEquals(listOf(spec), sent!!.tools)
    }

    // --- Debug logging (DebugLogSink) ---

    @Test
    fun `debug disabled produces no log file`() {
        val dir = java.nio.file.Files.createTempDirectory("aijb-debug-off")
        com.adb.stewart.debug.DebugLogSink.logDirectory = dir.toString()
        com.adb.stewart.debug.DebugLogSink.isEnabled = false
        server.createContext("/api/chat") { ex ->
            val body = """{"message":{"content":"x"},"done":true,"done_reason":"stop"}""" + "\n"
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        runBlocking { provider.chat(request()).collect { } }
        assertTrue(java.nio.file.Files.list(dir).use { it.count().toLong() } == 0L)
        assertEquals(0L, java.nio.file.Files.list(dir).use { it.count().toLong() })
        assertTrue(java.nio.file.Files.walk(dir).use { it.count().toLong() } == 1L)
    }

    @Test
    fun `debug enabled logs outgoing request and model`() {
        val dir = java.nio.file.Files.createTempDirectory("aijb-debug-out")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.logDirectory = dir.resolve("nested/").toString()
        sink.isEnabled = true
        try {
            server.createContext("/api/chat") { ex ->
                val body = """{"message":{"content":"x"},"done":true,"done_reason":"stop"}""" + "\n"
                ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
                ex.responseBody.use { it.write(body.toByteArray()) }
            }
            runBlocking { provider.chat(request()).collect { } }
            val files = java.nio.file.Files.list(dir.resolve("nested")).use { it.toList() }
            assertEquals(1, files.size)
            val content = java.nio.file.Files.readAllLines(files[0]).joinToString("\n")
            val outLines = content.lines().filter { it.contains("[outgoing]") }
            assertEquals(1, outLines.size)
            assertTrue(outLines[0].contains("[ollama]"))
            assertTrue(outLines[0].contains("[m]"))
            assertTrue(outLines[0].contains("\"model\":\"m\""))
            assertTrue(outLines[0].contains("\"stream\":true"))
            assertTrue(outLines[0].contains("[" + java.time.LocalDate.now() + "T"))
        } finally {
            sink.isEnabled = false
        }
    }

    @Test
    fun `debug enabled logs every ndjson chunk with chunk model`() {
        val dir = java.nio.file.Files.createTempDirectory("aijb-debug-chunk")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.logDirectory = dir.toString()
        sink.isEnabled = true
        try {
            server.createContext("/api/chat") { ex ->
                val body = """{"model":"chunky","message":{"content":"a"},"done":false}""" + "\n" +
                    "\n" +
                    """{"model":"chunky","done":true,"done_reason":"stop"}""" + "\n"
                ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
                ex.responseBody.use { it.write(body.toByteArray()) }
            }
            runBlocking { provider.chat(request()).collect { } }
            val files = java.nio.file.Files.list(dir).use { it.toList() }
            assertEquals(1, files.size)
            val content = java.nio.file.Files.readAllLines(files[0]).joinToString("\n")
            val inLines = content.lines().filter { it.contains("[incoming]") }
            assertEquals(2, inLines.size)
            assertTrue(inLines.all { it.contains("[chunky]") })
            assertTrue(inLines[0].contains("\"content\":\"a\""))
            val escaped = inLines[0].replace("\\n", "<NL>")
            org.junit.Assert.assertEquals(1, escaped.split("<NL>").size)
        } finally {
            sink.isEnabled = false
        }
    }

    @Test
    fun `debug chunk log falls back to request model when chunk omits model`() {
        val dir = java.nio.file.Files.createTempDirectory("aijb-debug-fallback")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.logDirectory = dir.toString()
        sink.isEnabled = true
        try {
            server.createContext("/api/chat") { ex ->
                val body = """{"message":{"content":"a"},"done":true,"done_reason":"stop"}""" + "\n"
                ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
                ex.responseBody.use { it.write(body.toByteArray()) }
            }
            runBlocking { provider.chat(request()).collect { } }
            val content = java.nio.file.Files.list(dir).use { files ->
                files.map { java.nio.file.Files.readAllLines(it).joinToString("\n") }.toList().joinToString("\n")
            }
            val inLines = content.lines().filter { it.contains("[incoming]") }
            assertEquals(1, inLines.size)
            assertTrue(inLines[0].contains("[m]"))
            val fallback = com.adb.stewart.provider.ollama.chunkModel("{bad", "req-model")
            assertEquals("req-model", fallback)
        } finally {
            sink.isEnabled = false
        }
    }

    @Test
    fun `debug log records http error body`() {
        val dir = java.nio.file.Files.createTempDirectory("aijb-debug-err")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.configure(true, dir.toString())
        try {
            server.createContext("/api/chat") { ex ->
                val body = """{"error":"model not found"}"""
                ex.sendResponseHeaders(500, body.toByteArray().size.toLong())
                ex.responseBody.use { it.write(body.toByteArray()) }
            }
            runBlocking { provider.chat(request()).collect { } }
            val content = debugLogContent(dir)
            val errors = content.lines().filter { it.contains("[error]") }
            assertTrue(errors.any { it.contains("HTTP 500") && it.contains("model not found") })
        } finally {
            sink.configure(false, "./log/debug_logs/")
        }
    }

    private fun debugLogContent(dir: java.nio.file.Path): String {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (java.nio.file.Files.isDirectory(dir)) {
                val files = java.nio.file.Files.list(dir).use { it.toList() }
                if (files.isNotEmpty()) {
                    return files.sortedBy { it.fileName.toString() }
                        .joinToString("\n") { java.nio.file.Files.readString(it) }
                }
            }
            Thread.sleep(10)
        }
        throw AssertionError("no debug log file was written")
    }

    @Test
    fun `debug logging failure does not break chat`() {
        val dir = java.nio.file.Files.createTempDirectory("aijb-debug-blocked")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.logDirectory = dir.resolve("file.log").toString()
        sink.isEnabled = true
        try {
            server.createContext("/api/chat") { ex ->
                val body = """{"message":{"content":"x"},"done":true,"done_reason":"stop"}""" + "\n"
                ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
                ex.responseBody.use { it.write(body.toByteArray()) }
            }
            val events = mutableListOf<ProviderEvent>()
            runBlocking { provider.chat(request()).collect { events.add(it) } }
            assertTrue(events.last() is ProviderEvent.Completed)
        } finally {
            sink.isEnabled = false
        }
    }
}

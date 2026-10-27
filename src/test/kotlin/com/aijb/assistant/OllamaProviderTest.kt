package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ollama.OllamaProvider
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OllamaProviderTest {

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
        assertEquals(null, (events.last() as ProviderEvent.Completed).finishReason)
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
        org.junit.Assert.assertNull(com.aijb.assistant.provider.ollama.OllamaNdjson.parseLine("{}"))
        org.junit.Assert.assertNull(com.aijb.assistant.provider.ollama.OllamaNdjson.parseLine("""{"message":{"content":""},"done":false}"""))
        val e = com.aijb.assistant.provider.ollama.OllamaNdjson.parseLine("""{"error":42}""")
        assertTrue(e is ProviderEvent.Failed)
        org.junit.Assert.assertNull(com.aijb.assistant.provider.ollama.OllamaNdjson.parseLine("""{"model":"m"}"""))
        val c = com.aijb.assistant.provider.ollama.OllamaNdjson.parseLine("""{"message":{"content":"y"},"done":false}""")
        assertEquals(ProviderEvent.TextDelta("y"), c)
        val d = com.aijb.assistant.provider.ollama.OllamaNdjson.parseLine("""{"done":true,"prompt_eval_count":1,"eval_count":2}""")
        assertTrue(d is ProviderEvent.Completed)
        assertEquals(1, (d as ProviderEvent.Completed).usage?.promptTokens)
        assertEquals(2, d.usage?.completionTokens)
    }

    @Test
    fun `native path with function choice`() = runBlocking {
        var sent: ChatRequest? = null
        val inner = object : com.aijb.assistant.provider.ModelProvider {
            override val id = "n"
            override suspend fun listModels() = emptyList<com.aijb.assistant.provider.ModelInfo>()
            override fun supportsNativeTools(model: String) = true
            override fun chat(request: ChatRequest) = kotlinx.coroutines.flow.flow<ProviderEvent> {
                sent = request
                emit(ProviderEvent.Completed("stop", null))
            }
        }
        val spec = com.aijb.assistant.provider.ToolSpec("read_file", "d", kotlinx.serialization.json.JsonObject(emptyMap()))
        val events = mutableListOf<ProviderEvent>()
        com.aijb.assistant.shim.ToolCallingProvider(inner, com.aijb.assistant.provider.ToolPath.NATIVE).chat(
            ChatRequest("m", listOf(ChatMessage(Role.USER, "g")),
                listOf(spec), com.aijb.assistant.provider.ToolChoice.Function("read_file"))).collect { events.add(it) }
        assertEquals(listOf(spec), sent!!.tools)
    }
}

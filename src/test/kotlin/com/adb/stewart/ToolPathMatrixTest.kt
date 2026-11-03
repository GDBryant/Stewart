package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.aif.AifHistory
import com.adb.stewart.provider.aif.AifProvider
import com.adb.stewart.provider.ollama.OllamaProvider
import com.adb.stewart.settings.ToolPathResolver
import com.adb.stewart.shim.ToolCallingProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopListener
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.ToolRegistry
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Provider (ollama, aif, claude) x tool-path override (absent, NATIVE, native, SHIM, garbage):
 * resolver -> ToolCallingProvider -> ToolLoop -> real wire format, with history carrying tool calls
 * from another provider.
 */
class ToolPathMatrixTest {

    private lateinit var server: HttpServer
    private val bodies = mutableListOf<JsonObject>()
    private var responses: List<String> = emptyList()
    private var executions = 0

    @Before fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val handler = com.sun.net.httpserver.HttpHandler { ex ->
            bodies += Json.parseToJsonElement(ex.requestBody.bufferedReader().readText()).jsonObject
            val r = responses.getOrElse(bodies.size - 1) { responses.last() }.toByteArray()
            ex.sendResponseHeaders(200, r.size.toLong())
            ex.responseBody.use { it.write(r) }
        }
        server.createContext("/api/chat", handler)
        server.createContext("/v1/chat/completions", handler)
        server.start()
    }

    @After fun tearDown() { server.stop(0) }

    private val url get() = "http://127.0.0.1:${server.address.port}"

    private val readFile = object : Tool {
        override val spec = ToolSpec("read_file", "Read a file", Json.parseToJsonElement(
            """{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}""").jsonObject)
        override val requiresApproval = false
        override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
            executions++
            return "contents of ${arguments["path"]!!.jsonPrimitive.content}"
        }
    }

    /** Prior turn run by Claude: its ids look like `toolu_*`. */
    private val claudeHistory = listOf(
        ChatMessage(Role.USER, "look at x"),
        ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
            ToolCall("toolu_prev", "read_file", JsonObject(mapOf("path" to JsonPrimitive("x")))))),
        ChatMessage(Role.TOOL, "contents of x", toolCallId = "toolu_prev"),
        ChatMessage(Role.ASSISTANT, "x read"),
        ChatMessage(Role.USER, "now read a"),
    )

    private class FakeClaude(private vararg val turns: List<ProviderEvent>) : ModelProvider {
        override val id = "claude"
        val requests = mutableListOf<ChatRequest>()
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun supportsNativeTools(model: String) = false
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            requests += request
            turns.getOrElse(requests.size - 1) { turns.last() }.forEach { emit(it) }
        }
    }

    private val shimCallText = "<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call>"

    private fun ollamaLine(content: String, toolCalls: String? = null) =
        """{"message":{"role":"assistant","content":${JsonPrimitive(content)}""" +
            (toolCalls?.let { ""","tool_calls":$it""" } ?: "") + """},"done":true,"done_reason":"stop"}""" + "\n"

    private fun aifSse(content: String?, toolCalls: String?, finish: String): String {
        val delta = buildString {
            append("{")
            content?.let { append("\"content\":${JsonPrimitive(it)}") }
            toolCalls?.let { if (content != null) append(","); append("\"tool_calls\":$it") }
            append("}")
        }
        return "data: {\"choices\":[{\"delta\":$delta,\"finish_reason\":\"$finish\"}]}\n\ndata: [DONE]\n\n"
    }

    private fun provider(id: String, override: String?): ModelProvider = when (id) {
        "ollama" -> OllamaProvider(url, java.net.http.HttpClient.newHttpClient())
        // Mirrors ProviderRegistry: AIF reports native support unless overridden to SHIM.
        "aif" -> AifProvider("$url/v1", listOf("m"), { "k" }, java.net.http.HttpClient.newHttpClient(),
            nativeTools = { override?.equals("SHIM", true) != true })
        else -> FakeClaude(
            listOf(ProviderEvent.TextDelta("reading"),
                ProviderEvent.NativeToolCalls(listOf(RawToolCall("toolu_1", "read_file", """{"path":"a"}"""))),
                ProviderEvent.Completed("tool_calls", null)),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
    }

    private fun script(id: String, path: ToolPath) {
        responses = when (id to path) {
            "ollama" to ToolPath.NATIVE -> listOf(
                ollamaLine("", """[{"function":{"name":"read_file","arguments":{"path":"a"}}}]"""),
                ollamaLine("done"))
            "ollama" to ToolPath.SHIM -> listOf(ollamaLine(shimCallText), ollamaLine("done"))
            "aif" to ToolPath.NATIVE -> listOf(
                aifSse(null, """[{"index":0,"id":"call_aif1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]""", "tool_calls"),
                aifSse("done", null, "stop"))
            "aif" to ToolPath.SHIM -> listOf(aifSse(shimCallText, null, "stop"), aifSse("done", null, "stop"))
            else -> listOf("")
        }
    }

    private class Case(val path: ToolPath, val result: LoopResult, val claude: FakeClaude?)

    private fun runCase(id: String, override: String?): Case {
        bodies.clear()
        executions = 0
        val ref = ModelRef(id, "m")
        val p = provider(id, override)
        val path = ToolPathResolver.resolve(ref, p, override?.let { mapOf(ref.encode() to it) } ?: emptyMap())
        script(id, path)
        val loop = ToolLoop(ToolCallingProvider(p, path), ToolRegistry(listOf(readFile)),
            ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val result = runBlocking { loop.run("m", claudeHistory, object : LoopListener {}) }
        return Case(path, result, p as? FakeClaude)
    }

    private val overrides = listOf(null, "NATIVE", "native", "SHIM", "shim", "garbage")

    private fun expected(id: String, override: String?): ToolPath = when {
        id == "claude" -> ToolPath.SHIM
        override == null -> if (id == "aif") ToolPath.NATIVE else ToolPath.SHIM
        override.equals("NATIVE", true) -> ToolPath.NATIVE
        else -> ToolPath.SHIM
    }

    private fun assertCompletedOnce(label: String, case: Case) {
        assertTrue("$label: ${case.result}", case.result is LoopResult.Completed)
        assertEquals("$label executions", 1, executions)
        val produced = case.result.messages
        val assistant = produced.first { it.toolCalls.isNotEmpty() }
        assertEquals(label, "read_file", assistant.toolCalls.single().name)
        assertEquals(label, assistant.toolCalls.single().id, produced.first { it.role == Role.TOOL }.toolCallId)
        assertEquals(label, "done", produced.last().content)
    }

    @Test
    fun `every provider and override resolves and completes a tool round trip`() {
        for (id in listOf("ollama", "aif", "claude")) for (o in overrides) {
            val label = "$id/$o"
            val case = runCase(id, o)
            assertEquals(label, expected(id, o), case.path)
            assertCompletedOnce(label, case)
            when {
                id == "claude" -> assertClaudeShim(label, case.claude!!)
                case.path == ToolPath.NATIVE -> assertNativeWire(label, id)
                else -> assertShimWire(label)
            }
        }
    }

    private fun msgs(body: JsonObject) = body["messages"]!!.jsonArray.map { it.jsonObject }
    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.content

    private fun assertNativeWire(label: String, id: String) {
        assertEquals(label, 2, bodies.size)
        bodies.forEach { assertTrue(label, it["tools"] is JsonArray) }
        val second = msgs(bodies[1])
        if (id == "aif") assertOpenAiPairing(label, second) else {
            val calls = second.filter { it["tool_calls"] != null }
            assertEquals(label, 2, calls.size)
            calls.forEach { m ->
                val args = m["tool_calls"]!!.jsonArray.single().jsonObject["function"]!!.jsonObject["arguments"]
                assertTrue("$label ollama arguments must be an object", args is JsonObject)
            }
            val tools = second.filter { it.str("role") == "tool" }
            assertEquals(label, listOf("read_file", "read_file"), tools.map { it.str("tool_name") })
            assertEquals(label, "contents of a", tools.last().str("content"))
        }
    }

    private fun assertShimWire(label: String) {
        assertEquals(label, 2, bodies.size)
        bodies.forEach { assertNull(label, it["tools"]) }
        val second = msgs(bodies[1])
        assertEquals(label, "system", second[0].str("role"))
        assertTrue(label, second[0].str("content")!!.contains("# Tools"))
        assertTrue(label, second.none { it.str("role") == "tool" || it["tool_calls"] != null })
        assertTrue(label, second.any { it.str("role") == "user" && it.str("content")!!.contains("<tool_response>") &&
            it.str("content")!!.contains("contents of a") })
    }

    private fun assertClaudeShim(label: String, claude: FakeClaude) {
        assertEquals(label, 2, claude.requests.size)
        claude.requests.forEach { assertTrue(label, it.tools.isEmpty()) }
        val second = claude.requests[1].messages
        assertTrue(label, second[0].role == Role.SYSTEM && second[0].content.contains("# Tools"))
        assertTrue(label, second.none { it.role == Role.TOOL || it.toolCalls.isNotEmpty() })
        assertTrue(label, second.last().content.contains("<tool_response>"))
    }

    /** OpenAI rule: every tool_calls block is answered, in order, by tool messages with matching ids. */
    private fun assertOpenAiPairing(label: String, messages: List<JsonObject>) {
        var pending = emptySet<String>()
        for (m in messages) {
            if (m.str("role") == "tool") {
                val id = m.str("tool_call_id")
                assertTrue("$label: orphan tool message $m", id != null && id in pending)
                pending = pending - id!!
            } else {
                assertTrue("$label: unanswered calls $pending", pending.isEmpty())
                val calls = m["tool_calls"]?.jsonArray?.map { it.jsonObject } ?: emptyList()
                calls.forEach { assertTrue(label, it["function"]!!.jsonObject["arguments"] is JsonPrimitive) }
                pending = calls.map { it.str("id")!! }.toSet()
                assertEquals("$label: duplicate ids", calls.size, pending.size)
                assertFalse(label, pending.any { it.isBlank() })
            }
        }
        assertTrue("$label: unanswered calls $pending", pending.isEmpty())
    }

    @Test
    fun `aif native history with foreign or missing ids stays valid`() {
        responses = listOf(aifSse("ok", null, "stop"))
        val bad = listOf(
            ChatMessage(Role.USER, "u"),
            // Valid Claude-origin pair is kept as native.
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(ToolCall("toolu_1", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "r1", toolCallId = "toolu_1"),
            // Blank id.
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(ToolCall("", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "r2", toolCallId = ""),
            // Result with no id, and an orphan result.
            ChatMessage(Role.ASSISTANT, "t", toolCalls = listOf(ToolCall("c3", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "r3"),
            ChatMessage(Role.USER, "next"),
            ChatMessage(Role.TOOL, "orphan", toolCallId = "zzz"),
            // Unanswered call, then duplicated ids.
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(ToolCall("c4", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                ToolCall("d", "read_file", JsonObject(emptyMap())), ToolCall("d", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "r5", toolCallId = "d"),
            ChatMessage(Role.TOOL, "r6", toolCallId = "d"),
            ChatMessage(Role.USER, "go"),
        )
        val p = ToolCallingProvider(
            AifProvider("$url/v1", listOf("m"), { "k" }, java.net.http.HttpClient.newHttpClient()), ToolPath.NATIVE)
        val events = runBlocking {
            mutableListOf<ProviderEvent>().also { l -> p.chat(ChatRequest("m", bad, listOf(readFile.spec))).collect { l += it } }
        }
        assertTrue(events.last() is ProviderEvent.Completed)
        val sent = msgs(bodies.single())
        assertOpenAiPairing("aif foreign", sent)
        assertEquals("toolu_1", sent.single { it.str("role") == "tool" }.str("tool_call_id"))
        assertTrue(sent.any { it.str("content")!!.contains("[tool result unknown] orphan") })
        assertTrue(sent.any { it.str("content") == "t\n[called tool read_file {}]" })
    }

    @Test
    fun `aif history sanitize keeps clean pairs untouched`() {
        assertEquals(claudeHistory, AifHistory.sanitize(claudeHistory))
        val parallel = listOf(
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                ToolCall("a", "read_file", JsonObject(emptyMap())), ToolCall("b", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "rb", toolCallId = "b"),
            ChatMessage(Role.TOOL, "ra", toolCallId = "a"),
        )
        assertEquals(parallel, AifHistory.sanitize(parallel))
    }

    @Test
    fun `aif history sanitize degrades extra or mismatched results`() {
        val extra = listOf(
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(ToolCall("a", "read_file", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "ra", toolCallId = "a"),
            ChatMessage(Role.TOOL, "rx", toolCallId = "x"),
        )
        val out = AifHistory.sanitize(extra)
        assertTrue(out.none { it.role == Role.TOOL || it.toolCalls.isNotEmpty() })
        assertEquals(listOf("[tool result read_file] ra", "[tool result unknown] rx"), out.drop(1).map { it.content })
    }

    @Test
    fun `ollama native history keeps foreign ids and names results`() {
        responses = listOf(ollamaLine("ok"))
        val p = ToolCallingProvider(OllamaProvider(url, java.net.http.HttpClient.newHttpClient()), ToolPath.NATIVE)
        val history = claudeHistory + ChatMessage(Role.TOOL, "orphan")
        runBlocking { p.chat(ChatRequest("m", history, listOf(readFile.spec))).collect { } }
        val sent = msgs(bodies.single())
        val tools = sent.filter { it.str("role") == "tool" }
        assertEquals("read_file", tools[0].str("tool_name"))
        assertNull(tools[1]["tool_name"])
    }

    @Test
    fun `claude shim does not double execute a call sent natively and as text`() {
        executions = 0
        val claude = FakeClaude(
            listOf(ProviderEvent.TextDelta(shimCallText),
                ProviderEvent.NativeToolCalls(listOf(RawToolCall("toolu_1", "read_file", """{"path":"a"}"""))),
                ProviderEvent.Completed("tool_calls", null)),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        val loop = ToolLoop(ToolCallingProvider(claude, ToolPath.SHIM), ToolRegistry(listOf(readFile)),
            ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val result = runBlocking { loop.run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {}) }
        assertTrue(result is LoopResult.Completed)
        assertEquals(1, executions)
        assertEquals("toolu_1", result.messages.first().toolCalls.single().id)
    }

    @Test
    fun `claude inventing an unoffered tool gets an unknown tool result and the loop continues`() {
        executions = 0
        val claude = FakeClaude(
            listOf(ProviderEvent.NativeToolCalls(listOf(RawToolCall("t1", "bash", "{}"))),
                ProviderEvent.Completed("tool_calls", null)),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        val loop = ToolLoop(ToolCallingProvider(claude, ToolPath.SHIM), ToolRegistry(listOf(readFile)),
            ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val result = runBlocking { loop.run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {}) }
        assertTrue(result.toString(), result is LoopResult.Completed)
        assertEquals(0, executions)
        assertEquals("Invalid tool call: unknown tool 'bash'", result.messages[1].content)
        assertTrue(claude.requests[1].messages.last().content.contains("unknown tool 'bash'"))
        assertEquals("done", result.messages.last().content)
    }

    @Test
    fun `tool less request from claude never reports tool_calls without calls`() {
        val claude = FakeClaude(listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("t1", "bash", "{}"))),
            ProviderEvent.Completed("tool_calls", null)))
        val events = runBlocking {
            mutableListOf<ProviderEvent>().also { l ->
                ToolCallingProvider(claude, ToolPath.SHIM).chat(ChatRequest("m", listOf(ChatMessage(Role.USER, "sum")))).collect { l += it }
            }
        }
        assertEquals(listOf<ProviderEvent>(ProviderEvent.Completed("stop", null)), events)
    }
}

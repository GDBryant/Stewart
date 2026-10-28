package com.aijb.assistant

import com.aijb.assistant.chat.ContextCompactor
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.RawToolCall
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopListener
import com.aijb.assistant.tools.LoopLimits
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolLoop
import com.aijb.assistant.tools.ToolOutcome
import com.aijb.assistant.tools.ToolRegistry
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolLoopTest {

    private fun spec(name: String = "t", schema: JsonObject = JsonObject(emptyMap()), approval: Boolean = true) =
        ToolSpec(name, "d", schema)

    private fun tool(
        name: String = "t", schema: JsonObject = JsonObject(emptyMap()),
        approval: Boolean = false, run: suspend (JsonObject) -> String = { "ok" },
    ) = object : Tool {
        override val spec = ToolSpec(name, "d", schema)
        override val requiresApproval = approval
        override suspend fun execute(arguments: JsonObject) = run(arguments)
    }

    private class Fake(vararg val evs: ProviderEvent) : ModelProvider {
        override val id = "fake"
        var calls = 0
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            if (calls++ == 0) evs.forEach { emit(it) } else emit(ProviderEvent.Completed("stop", null))
        }
    }

    private fun approve() = ApprovalGate { ApprovalDecision.Approved }
    private fun deny() = ApprovalGate { ApprovalDecision.Rejected("no") }

    private fun call(name: String = "t", id: String = "c1", args: JsonObject = JsonObject(emptyMap())) =
        ToolCall(id, name, args)

    private fun run(vararg evs: ProviderEvent, tools: List<Tool>, gate: ApprovalGate = approve(), limits: LoopLimits = LoopLimits(), history: List<ChatMessage> = listOf(ChatMessage(Role.USER, "go")), listener: LoopListener = object : LoopListener {}) =
        runBlocking { ToolLoop(Fake(*evs), ToolRegistry(tools), gate, limits).run("m", history, listener) }

    private val schemaWithReq = JsonObject(mapOf(
        "type" to JsonPrimitive("object"),
        "properties" to JsonObject(mapOf("path" to JsonObject(mapOf("type" to JsonPrimitive("string"))))),
        "required" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("path"))),
    ))

    @Test
    fun `no calls completes`() {
        val r = run(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null), tools = listOf(tool()))
        assertTrue(r is LoopResult.Completed)
        assertEquals("done", (r as LoopResult.Completed).messages[0].content)
    }

    @Test
    fun `approved tool runs and result fed back`() {
        var ran = false
        val t = tool("t", approval = true) { ran = true; "result!" }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t), gate = approve())
        assertTrue(ran)
        assertTrue(r is LoopResult.Completed)
        val toolMsg = r.messages.last { it.role == Role.TOOL }
        assertEquals("result!", toolMsg.content)
        assertEquals("c1", toolMsg.toolCallId)
    }

    @Test
    fun `denied tool rejected`() {
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t", approval = true)), gate = deny())
        assertEquals("Rejected by user: no", r.messages.last { it.role == Role.TOOL }.content)
    }

    @Test
    fun `schema violation invalid`() {
        val r = run(
            ProviderEvent.ToolCalls(listOf(call(args = JsonObject(emptyMap())))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t", schema = schemaWithReq)))
        assertTrue(r.messages.last { it.role == Role.TOOL }.content.startsWith("Invalid tool call:"))
    }

    @Test
    fun `unknown tool invalid`() {
        val r = run(
            ProviderEvent.ToolCalls(listOf(call("other"))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t")))
        assertTrue(r.messages.last { it.role == Role.TOOL }.content.contains("unknown tool"))
    }

    @Test
    fun `duplicate call id invalid`() {
        var count = 0
        val t = tool { count++; "x" }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call(id = "c"), call(id = "c"))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t))
        assertEquals(1, count)
        assertTrue(r.messages.filter { it.role == Role.TOOL }.last().content.contains("duplicate"))
    }

    @Test
    fun `tool timeout uncertain`() {
        val t = tool { delay(10_000); "never" }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t), limits = LoopLimits(toolTimeout = 50.milliseconds))
        assertTrue(r.messages.last { it.role == Role.TOOL }.content.contains("Outcome uncertain"))
    }

    @Test
    fun `tool exception is failure`() {
        val t = tool { throw RuntimeException("kaput") }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t))
        assertEquals("Error: kaput", r.messages.last { it.role == Role.TOOL }.content)
    }

    @Test
    fun `output truncated`() {
        val t = tool { "x".repeat(100) }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t), limits = LoopLimits(maxToolOutputChars = 10))
        assertTrue(r.messages.last { it.role == Role.TOOL }.content.endsWith("[output truncated]"))
    }

    @Test
    fun `failed stream runs nothing`() {
        var ran = false
        val t = tool { ran = true; "x" }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Failed("boom"),
            tools = listOf(t))
        assertTrue(!ran && r is LoopResult.Failed)
    }

    @Test
    fun `stream without completed fails`() {
        val r = run(ProviderEvent.TextDelta("x"), tools = listOf(tool()))
        assertEquals("incomplete_stream", (r as LoopResult.Failed).code)
    }

    @Test
    fun `native calls reaching loop is protocol error`() {
        val r = run(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall("x", "t", "{}"))),
            ProviderEvent.Completed("stop", null), tools = listOf(tool()))
        assertEquals("protocol_error", (r as LoopResult.Failed).code)
    }

    @Test
    fun `truncated finish fails with text kept`() {
        val r = run(ProviderEvent.TextDelta("partial"), ProviderEvent.Completed("length", null), tools = listOf(tool()))
        assertEquals("truncated", (r as LoopResult.Failed).code)
        assertEquals("partial", r.messages[0].content)
    }

    @Test
    fun `turn limit reached`() {
        val t = tool { "x" }
        val r = run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t), limits = LoopLimits(maxModelTurns = 1))
        assertTrue(r is LoopResult.TurnLimitReached)
    }

    @Test
    fun `context limit`() {
        val r = run(tools = listOf(tool()), limits = LoopLimits(maxContextChars = 5),
            history = listOf(ChatMessage(Role.USER, "this is longer than five")))
        assertEquals("context_limit", (r as LoopResult.Failed).code)
    }

    @Test
    fun `gate reviews exact arguments`() {
        val args = buildJsonObject { put("path", "a") }
        var reviewed: JsonObject? = null
        val t = tool("t", approval = true) { "x" }
        run(
            ProviderEvent.ToolCalls(listOf(call(args = args))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t), gate = ApprovalGate { reviewed = it.arguments; ApprovalDecision.Approved })
        assertTrue(reviewed === args)
    }

    @Test
    fun `cancel during execute reports uncertain`() {
        val outcomes = mutableListOf<ToolOutcome>()
        val listener = object : LoopListener {
            override fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) {
                outcomes.add(outcome)
            }
        }
        val t = tool { suspendCancellableCoroutine<String> { } }
        val e = assertThrows(CancellationException::class.java) {
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.withTimeout(50) {
                    ToolLoop(Fake(
                        ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null)),
                        ToolRegistry(listOf(t)), approve(), LoopLimits(toolTimeout = kotlin.time.Duration.INFINITE))
                        .run("m", listOf(ChatMessage(Role.USER, "go")), listener)
                }
            }
        }
        assertEquals(ToolOutcome.Uncertain("cancelled; side effects unknown"), outcomes.single())
    }

    @Test
    fun `reasoning and text forwarded to listener`() {
        val heard = StringBuilder()
        val l = object : LoopListener {
            override fun onText(text: String) { heard.append(text) }
            override fun onReasoning(text: String) { heard.append("R$text") }
        }
        run(ProviderEvent.ReasoningDelta("r"), ProviderEvent.TextDelta("t"),
            ProviderEvent.Completed("stop", null), tools = listOf(tool()), listener = l)
        assertEquals("Rrt", heard.toString())
    }

    @Test
    fun `no approval tool runs without gate`() {
        var gateCalled = false
        run(ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool(approval = false)), gate = ApprovalGate { gateCalled = true; ApprovalDecision.Approved })
        assertTrue(!gateCalled)
    }

    @Test
    fun `schema rejects additional property when closed`() {
        val schema = JsonObject(mapOf(
            "type" to JsonPrimitive("object"),
            "properties" to JsonObject(mapOf("path" to JsonObject(mapOf("type" to JsonPrimitive("string"))))),
            "additionalProperties" to JsonPrimitive(false)))
        val bad = JsonObject(mapOf("path" to JsonPrimitive("a"), "extra" to JsonPrimitive(1)))
        val r = run(ProviderEvent.ToolCalls(listOf(call(args = bad))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t", schema = schema)))
        assertTrue(r.messages.last { it.role == Role.TOOL }.content.contains("Invalid"))
    }

    @Test
    fun `schema type and enum checks`() {
        val schema = JsonObject(mapOf(
            "type" to JsonPrimitive("object"),
            "properties" to JsonObject(mapOf(
                "n" to JsonObject(mapOf("type" to JsonPrimitive("integer"))),
                "mode" to JsonObject(mapOf("enum" to kotlinx.serialization.json.JsonArray(
                    listOf(JsonPrimitive("a"), JsonPrimitive("b")))))))))
        val badArgs = JsonObject(mapOf("n" to JsonPrimitive("x")))
        val r = run(ProviderEvent.ToolCalls(listOf(call(args = badArgs))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t", schema = schema)))
        assertTrue(r.messages.last { it.role == Role.TOOL }.content.contains("Invalid"))
        val badEnum = JsonObject(mapOf("mode" to JsonPrimitive("z")))
        val r2 = run(ProviderEvent.ToolCalls(listOf(call(args = badEnum))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t", schema = schema)))
        assertTrue(r2.messages.last { it.role == Role.TOOL }.content.contains("Invalid"))
        val ok = JsonObject(mapOf("n" to JsonPrimitive(3), "mode" to JsonPrimitive("a")))
        val r3 = run(ProviderEvent.ToolCalls(listOf(call(args = ok))), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(tool("t", schema = schema)))
        assertEquals("ok", r3.messages.last { it.role == Role.TOOL }.content)
    }

    @Test
    fun `event after completed is protocol error`() {
        val r = run(ProviderEvent.Completed("stop", null), ProviderEvent.TextDelta("late"),
            tools = listOf(tool()))
        assertEquals("protocol_error", (r as LoopResult.Failed).code)
    }

    @Test
    fun `text after completed is protocol error`() {
        val r = run(ProviderEvent.Completed("stop", null), ProviderEvent.TextDelta("x"),
            tools = listOf(tool()))
        assertEquals("protocol_error", (r as LoopResult.Failed).code)
    }

    private class SummaryAware(
        private val mainResponses: List<List<ProviderEvent>>,
        private val summaryEvents: List<ProviderEvent>,
    ) : ModelProvider {
        override val id = "fake"
        val requests = mutableListOf<ChatRequest>()
        var mainCalls = 0
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            requests += request
            val isSummary = request.messages.any {
                it.role == Role.SYSTEM && it.content == ContextCompactor.SUMMARY_PROMPT
            }
            val evs = if (isSummary) {
                summaryEvents
            } else {
                mainResponses.getOrElse(mainCalls) { listOf(ProviderEvent.Completed("stop", null)) }
                    .also { mainCalls++ }
            }
            return flow { evs.forEach { emit(it) } }
        }
    }

    private class RecordingLoopListener : LoopListener {
        val compacted = mutableListOf<Pair<Int, Int>>()
        val compactionFailures = mutableListOf<String>()
        override fun onCompacted(beforeTokens: Int, afterTokens: Int) {
            compacted += beforeTokens to afterTokens
        }
        override fun onCompactionFailed(message: String) {
            compactionFailures += message
        }
    }

    private fun bigHistory(n: Int): List<ChatMessage> =
        (1..n).flatMap {
            listOf(
                ChatMessage(Role.USER, "q$it " + "x".repeat(40)),
                ChatMessage(Role.ASSISTANT, "a$it " + "y".repeat(40)),
            )
        }

    @Test
    fun `compaction on first turn replaces base`() {
        val provider = SummaryAware(
            listOf(listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null))),
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
        )
        val listener = RecordingLoopListener()
        val history = bigHistory(6)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(),
                LoopLimits(compactAtTokens = 10)).run("m", history, listener)
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(1, listener.compacted.size)
        assertTrue(r.base[0].content.startsWith(ContextCompactor.SUMMARY_PREFIX))
        assertTrue(r.base.none { it.content.startsWith("q1 ") })
        assertEquals(r.base + r.messages, r.transcript)
        assertEquals(2, provider.requests.size)
        assertTrue(provider.requests[1].messages[0].content.startsWith(ContextCompactor.SUMMARY_PREFIX))
    }

    @Test
    fun `compaction between turns folds produced into base`() {
        val provider = SummaryAware(
            listOf(
                listOf(
                    ProviderEvent.ToolCalls(listOf(call(id = "c9"))),
                    ProviderEvent.Completed("stop", com.aijb.assistant.provider.Usage(60_000, 5)),
                ),
                listOf(ProviderEvent.TextDelta("final"), ProviderEvent.Completed("stop", null)),
            ),
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
        )
        val listener = RecordingLoopListener()
        val history = listOf(
            ChatMessage(Role.USER, "old go"),
            ChatMessage(Role.ASSISTANT, "calls", toolCalls = listOf(call())),
            ChatMessage(Role.TOOL, "old result", toolCallId = "c1"),
        ) + bigHistory(3)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(),
                LoopLimits(compactAtTokens = 50_000),
                ContextCompactor(keepRecent = 1)).run("m", history, listener)
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(1, listener.compacted.size)
        assertTrue(r.base[0].content.startsWith(ContextCompactor.SUMMARY_PREFIX))
        assertEquals(listOf("final"), r.messages.map { it.content })
        assertEquals(r.base + r.messages, r.transcript)
        val summaryReq = provider.requests[1]
        assertTrue(summaryReq.messages[1].content.contains("[tool result c1] old result"))
    }

    @Test
    fun `compaction failure continues with full history`() {
        val provider = SummaryAware(
            listOf(listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null))),
            listOf(ProviderEvent.Failed("no summary")),
        )
        val listener = RecordingLoopListener()
        val history = bigHistory(6)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(),
                LoopLimits(compactAtTokens = 10)).run("m", history, listener)
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(listOf("no summary"), listener.compactionFailures)
        assertTrue(listener.compacted.isEmpty())
        assertEquals(history, r.base)
        assertEquals(history, provider.requests[1].messages)
    }

    @Test
    fun `role prompt prepended on every turn but not in transcript`() {
        val provider = SummaryAware(
            listOf(
                listOf(
                    ProviderEvent.ToolCalls(listOf(call())),
                    ProviderEvent.Completed("stop", null),
                ),
                listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
            ),
            emptyList(),
        )
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(), LoopLimits(),
                ContextCompactor(), "ROLE PROMPT X").run("m",
                listOf(ChatMessage(Role.USER, "go")), RecordingLoopListener())
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(2, provider.requests.size)
        provider.requests.forEach { req ->
            assertEquals(Role.SYSTEM, req.messages[0].role)
            assertEquals("ROLE PROMPT X", req.messages[0].content)
        }
        assertTrue(r.transcript.none { it.content == "ROLE PROMPT X" })
    }

    @Test
    fun `null role prompt sends no system injection`() {
        val provider = SummaryAware(
            listOf(listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null))),
            emptyList(),
        )
        runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(), LoopLimits())
                .run("m", listOf(ChatMessage(Role.USER, "go")), RecordingLoopListener())
        }
        assertTrue(provider.requests[0].messages.none {
            it.role == Role.SYSTEM && it.content == "ROLE PROMPT X"
        })
        assertEquals(Role.USER, provider.requests[0].messages[0].role)
    }

    @Test
    fun `role prompt not in compactor input`() {
        val provider = SummaryAware(
            listOf(listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null))),
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
        )
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(),
                LoopLimits(compactAtTokens = 10), ContextCompactor(), "ROLE PROMPT X")
                .run("m", bigHistory(6), RecordingLoopListener())
        }
        assertTrue(r is LoopResult.Completed)
        val summaryReq = provider.requests[0]
        assertTrue(summaryReq.messages.none { it.content.contains("ROLE PROMPT X") })
        assertEquals("ROLE PROMPT X", provider.requests[1].messages[0].content)
    }

    @Test
    fun `null compactAtTokens never sends summary request`() {
        val provider = SummaryAware(
            listOf(listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null))),
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
        )
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(), LoopLimits())
                .run("m", bigHistory(6), RecordingLoopListener())
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(1, provider.requests.size)
        assertTrue(provider.requests[0].messages.none {
            it.content == ContextCompactor.SUMMARY_PROMPT
        })
    }
}

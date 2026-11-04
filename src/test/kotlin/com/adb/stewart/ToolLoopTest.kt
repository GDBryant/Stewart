package com.adb.stewart

import com.adb.stewart.chat.ContextCompactor
import com.adb.stewart.debug.DebugLogSink
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.Usage
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopListener
import com.adb.stewart.tools.LoopLimits
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolOutcome
import com.adb.stewart.tools.ToolRegistry
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
import org.junit.Assert.assertNull
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
        override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?) = run(arguments)
    }

    private class Fake(vararg val evs: ProviderEvent) : ModelProvider {
        override val id = "fake"
        var calls = 0
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            if (calls++ == 0) evs.forEach { emit(it) } else emit(ProviderEvent.Completed("stop", null))
        }
    }

    private class Scripted(vararg val responses: List<ProviderEvent>) : ModelProvider {
        override val id = "fake"
        var calls = 0
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            (responses.getOrElse(calls++) { listOf(ProviderEvent.Completed("stop", null)) })
                .forEach { emit(it) }
        }
    }

    private fun approve() = ApprovalGate { _, _ -> ApprovalDecision.Approved }
    private fun deny() = ApprovalGate { _, _ -> ApprovalDecision.Rejected("no") }

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

    private fun truncatedLog(usage: Usage?, expectLog: Boolean): String {
        val dir = java.nio.file.Files.createTempDirectory("stewart-trunc-")
        val prevEnabled = DebugLogSink.isEnabled
        val prevDir = DebugLogSink.logDirectory
        try {
            DebugLogSink.configure(true, dir.toString())
            val r = run(ProviderEvent.TextDelta("partial"), ProviderEvent.Completed("length", usage), tools = listOf(tool()))
            assertEquals("truncated", (r as LoopResult.Failed).code)
            fun read() = java.nio.file.Files.list(dir).use { it.toList() }
                .joinToString("\n") { java.nio.file.Files.readString(it) }
            // The sink writes on a background thread; wait for content (or give up for the negative case).
            val deadline = System.currentTimeMillis() + (if (expectLog) 10_000 else 300)
            while (System.currentTimeMillis() < deadline && read().isEmpty()) Thread.sleep(10)
            DebugLogSink.flush()
            return read()
        } finally {
            DebugLogSink.flushAndClose()
            DebugLogSink.configure(prevEnabled, prevDir)
        }
    }

    @Test
    fun `truncated failure logs prompt tokens when usage has them`() {
        val log = truncatedLog(Usage(promptTokens = 4321, completionTokens = 9), true)
        assertTrue(log, log.contains("response truncated (length): prompt_tokens=4321"))
    }

    @Test
    fun `truncated failure logs nothing without prompt tokens`() {
        assertEquals("", truncatedLog(null, false))
        assertEquals("", truncatedLog(Usage(promptTokens = null, completionTokens = 9), false))
    }

    @Test
    fun `non truncated failure writes no prompt tokens log line`() {
        val dir = java.nio.file.Files.createTempDirectory("stewart-rl-")
        val prevEnabled = DebugLogSink.isEnabled
        val prevDir = DebugLogSink.logDirectory
        try {
            DebugLogSink.configure(true, dir.toString())
            val r = run(ProviderEvent.Failed("slow down", code = "rate_limit"), tools = listOf(tool()))
            assertEquals("rate_limit", (r as LoopResult.Failed).code)
            Thread.sleep(300)
            DebugLogSink.flush()
            val log = java.nio.file.Files.list(dir).use { it.toList() }
                .joinToString("\n") { java.nio.file.Files.readString(it) }
            assertTrue(log, !log.contains("prompt_tokens"))
        } finally {
            DebugLogSink.flushAndClose()
            DebugLogSink.configure(prevEnabled, prevDir)
        }
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
    fun `resumed run continues and history is valid`() {
        val t = tool { "x" }
        val limit = LoopLimits(maxModelTurns = 1)
        val first = runBlocking {
            ToolLoop(Fake(ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null)),
                ToolRegistry(listOf(t)), approve(), limit)
                .run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        } as LoopResult.TurnLimitReached
        val resumed = first.base + first.messages
        val callIds = resumed.flatMap { it.toolCalls }.map { it.id }
        val resultIds = resumed.filter { it.role == Role.TOOL }.map { it.toolCallId }
        assertEquals(callIds, resultIds)
        val provider = Scripted(listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)))
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(t)), approve(), limit).run("m", resumed, object : LoopListener {})
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(resumed, r.base)
        assertEquals("done", r.messages.last().content)
    }

    @Test
    fun `resumed run hits limit again with fresh budget`() {
        val t = tool { "x" }
        val provider = Scripted(
            listOf(ProviderEvent.ToolCalls(listOf(call(id = "n1"))), ProviderEvent.Completed("tool_calls", null)))
        val hist = listOf(ChatMessage(Role.USER, "go"),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(call())), ChatMessage(Role.TOOL, "x", toolCallId = "c1"))
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(t)), approve(), LoopLimits(maxModelTurns = 1)).run("m", hist, object : LoopListener {})
        }
        assertTrue(r is LoopResult.TurnLimitReached)
        assertEquals(2, r.messages.size)
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
            tools = listOf(t), gate = ApprovalGate { c, _ -> reviewed = c.arguments; ApprovalDecision.Approved })
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
            tools = listOf(tool(approval = false)), gate = ApprovalGate { _, _ -> gateCalled = true; ApprovalDecision.Approved })
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

    @Test
    fun `preview exception fails without approval`() {
        var reviews = 0
        var outcome: ToolOutcome? = null
        val t = object : Tool {
            override val spec = spec("t")
            override val requiresApproval = true
            override suspend fun preview(arguments: JsonObject): com.adb.stewart.tools.ToolPreview? {
                throw IllegalStateException("bad args")
            }
            override suspend fun execute(
                arguments: JsonObject,
                preview: com.adb.stewart.tools.ToolPreview?,
            ) = "ok"
        }
        run(
            ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null),
            tools = listOf(t),
            gate = ApprovalGate { _, _ -> reviews++; ApprovalDecision.Approved },
            listener = object : LoopListener {
                override fun onToolOutcome(call: ToolCall, o: ToolOutcome) { outcome = o }
            })
        assertEquals(0, reviews)
        assertTrue(outcome is ToolOutcome.Failure)
    }

    private fun bigHistory(n: Int): List<ChatMessage> =
        (1..n).flatMap {
            listOf(
                ChatMessage(Role.USER, "q$it " + "x".repeat(40)),
                ChatMessage(Role.ASSISTANT, "a$it " + "y".repeat(40)),
            )
        }

    private val truncated = listOf(ProviderEvent.TextDelta("partial"), ProviderEvent.Completed("length", null))
    private val summary = listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null))
    private val finished = listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null))

    @Test
    fun `output limit compacts and retries`() {
        val provider = SummaryAware(listOf(truncated, finished), summary)
        val listener = RecordingLoopListener()
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve()).run("m", bigHistory(6), listener)
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals(1, listener.compacted.size)
        assertEquals(2, provider.mainCalls)
        assertTrue(r.base[0].content.startsWith(ContextCompactor.SUMMARY_PREFIX))
        // The truncated partial reply is dropped from the transcript.
        assertEquals(listOf("done"), r.messages.map { it.content })
    }

    @Test
    fun `output limit retries only once in a row`() {
        val provider = SummaryAware(listOf(truncated, truncated, finished), summary)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve())
                .run("m", bigHistory(6), RecordingLoopListener())
        }
        assertEquals("truncated", (r as LoopResult.Failed).code)
        assertEquals(2, provider.mainCalls)
    }

    @Test
    fun `output limit with retries disabled fails without compacting`() {
        val provider = SummaryAware(listOf(truncated, finished), summary)
        val listener = RecordingLoopListener()
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(), LoopLimits(maxTruncationRetries = 0))
                .run("m", bigHistory(6), listener)
        }
        assertEquals("truncated", (r as LoopResult.Failed).code)
        assertTrue(listener.compacted.isEmpty())
        assertEquals(1, provider.requests.size)
    }

    @Test
    fun `output limit with nothing to compact fails as truncated`() {
        val provider = SummaryAware(listOf(truncated, finished), summary)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve())
                .run("m", listOf(ChatMessage(Role.USER, "go")), RecordingLoopListener())
        }
        assertEquals("truncated", (r as LoopResult.Failed).code)
        assertEquals("partial", r.messages.last().content)
        assertEquals(1, provider.requests.size)
    }

    @Test
    fun `output limit with failed compaction reports it and fails`() {
        val provider = SummaryAware(
            listOf(truncated, finished),
            listOf(ProviderEvent.Failed("boom")),
        )
        val listener = RecordingLoopListener()
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve()).run("m", bigHistory(6), listener)
        }
        assertEquals("truncated", (r as LoopResult.Failed).code)
        assertEquals(listOf("boom"), listener.compactionFailures)
    }

    @Test
    fun `content filter is not retried`() {
        val provider = SummaryAware(
            listOf(listOf(ProviderEvent.Completed("content_filter", null)), finished), summary)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve())
                .run("m", bigHistory(6), RecordingLoopListener())
        }
        assertEquals("truncated", (r as LoopResult.Failed).code)
        assertEquals(1, provider.requests.size)
    }

    @Test
    fun `retry budget resets after a successful turn`() {
        val call = listOf(ProviderEvent.ToolCalls(listOf(call())), ProviderEvent.Completed("tool_calls", null))
        val provider = SummaryAware(listOf(truncated, call, truncated, finished), summary)
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool())), approve(), compactor = ContextCompactor(keepRecent = 1))
                .run("m", bigHistory(6), RecordingLoopListener())
        }
        assertTrue(r is LoopResult.Completed)
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
                    ProviderEvent.Completed("stop", com.adb.stewart.provider.Usage(60_000, 5)),
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

    private fun terminalPlanTool() = tool(
        name = "submit_plan",
        schema = JsonObject(mapOf(
            "type" to JsonPrimitive("object"),
            "properties" to JsonObject(mapOf("goal" to JsonObject(mapOf("type" to JsonPrimitive("string"))))),
            "required" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("goal"))),
        )),
    )

    @Test
    fun `terminal tool success completes without another model turn`() {
        val fake = Fake(
            ProviderEvent.ToolCalls(listOf(ToolCall("c1", "submit_plan", JsonObject(mapOf("goal" to JsonPrimitive("g")))))),
            ProviderEvent.Completed("tool_calls", null),
        )
        val r = runBlocking {
            ToolLoop(fake, ToolRegistry(listOf(terminalPlanTool())), approve(), LoopLimits(),
                terminalTools = setOf("submit_plan"),
            ).run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals("c1", (r as LoopResult.Completed).submitted?.id)
        assertEquals(1, fake.calls)
        // A lone terminal call gets exactly one result.
        assertEquals(1, r.messages.count { it.role == Role.TOOL })
    }

    @Test
    fun `calls after a terminal call are answered as not executed`() {
        var ran = 0
        val other = tool(name = "t", run = { ran++; "ok" })
        val fake = Fake(
            ProviderEvent.ToolCalls(listOf(
                ToolCall("c1", "submit_plan", JsonObject(mapOf("goal" to JsonPrimitive("g")))),
                ToolCall("c2", "t", JsonObject(emptyMap())))),
            ProviderEvent.Completed("tool_calls", null),
        )
        val r = runBlocking {
            ToolLoop(fake, ToolRegistry(listOf(terminalPlanTool(), other)), approve(), LoopLimits(),
                terminalTools = setOf("submit_plan"),
            ).run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        }
        assertEquals("c1", (r as LoopResult.Completed).submitted?.id)
        assertEquals(0, ran)
        val results = r.messages.filter { it.role == Role.TOOL }
        assertEquals(listOf("c1", "c2"), results.map { it.toolCallId })
        assertEquals("Not executed: 'submit_plan' ended the turn", results[1].content)
    }

    @Test
    fun `plain finish leaves submitted null`() {
        val fake = Fake(ProviderEvent.TextDelta("hi"), ProviderEvent.Completed("stop", null))
        val r = runBlocking {
            ToolLoop(fake, ToolRegistry(listOf(terminalPlanTool())), approve(), LoopLimits(),
                terminalTools = setOf("submit_plan"),
            ).run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        }
        assertNull((r as LoopResult.Completed).submitted)
    }

    @Test
    fun `terminal tool with invalid args retries instead of stopping`() {
        val fake = Scripted(
            listOf(
                ProviderEvent.ToolCalls(listOf(ToolCall("c1", "submit_plan", JsonObject(emptyMap())))),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(
                ProviderEvent.ToolCalls(listOf(ToolCall("c2", "submit_plan", JsonObject(mapOf("goal" to JsonPrimitive("g")))))),
                ProviderEvent.Completed("tool_calls", null),
            ),
        )
        val r = runBlocking {
            ToolLoop(fake, ToolRegistry(listOf(terminalPlanTool())), approve(), LoopLimits(),
                terminalTools = setOf("submit_plan"),
            ).run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        }
        assertTrue(r is LoopResult.Completed)
        assertEquals("c2", (r as LoopResult.Completed).submitted?.id)
        assertEquals(2, fake.calls)
    }

    @Test
    fun `terminal tool that throws does not end the loop`() {
        val rejecting = object : Tool {
            override val spec = ToolSpec("submit_plan", "d", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String =
                throw IllegalStateException("bad plan")
        }
        val fake = Scripted(
            listOf(
                ProviderEvent.ToolCalls(listOf(ToolCall("c1", "submit_plan", JsonObject(emptyMap())))),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("giving up"), ProviderEvent.Completed("stop", null)),
        )
        val r = runBlocking {
            ToolLoop(fake, ToolRegistry(listOf(rejecting)), approve(), LoopLimits(),
                terminalTools = setOf("submit_plan"),
            ).run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        } as LoopResult.Completed
        assertNull(r.submitted)
        assertEquals(2, fake.calls)
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content == "Error: bad plan" })
    }
}

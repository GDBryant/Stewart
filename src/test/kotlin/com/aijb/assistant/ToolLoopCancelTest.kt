package com.aijb.assistant

import com.aijb.assistant.tools.LoopLimits
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopListener
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.RunCancelledException
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolLoop
import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.tools.ToolRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** End-to-end cancellation of [ToolLoop]: what survives, what is reported as uncertain. */
class ToolLoopCancelTest {

    private fun scripted(vararg turns: List<ProviderEvent>) = object : ModelProvider {
        override val id = "fake"
        var n = 0
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            val turn = turns.getOrNull(n++)
            if (turn == null) {
                awaitCancellation()
            }
            turn.forEach { emit(it) }
            if (turn.none { it is ProviderEvent.Completed }) awaitCancellation()
        }
    }

    private fun call(id: String, name: String = "t") = ToolCall(id, name, JsonObject(emptyMap()))

    private fun tool(name: String = "t", approval: Boolean = false, run: suspend () -> String) = object : Tool {
        override val spec = com.aijb.assistant.provider.ToolSpec(name, "d", JsonObject(emptyMap()))
        override val requiresApproval = approval
        override suspend fun execute(arguments: JsonObject, preview: ToolPreview?) = run()
    }

    private val approve = ApprovalGate { _, _ -> ApprovalDecision.Approved }
    private val history = listOf(ChatMessage(Role.USER, "go"))

    /** Runs the loop, cancels once [ready] fires, and returns the captured cancellation. */
    private fun cancelWhen(
        loop: ToolLoop,
        ready: CountDownLatch,
        listener: LoopListener = object : LoopListener {},
        history: List<ChatMessage> = this.history,
    ): RunCancelledException {
        val captured = AtomicReference<RunCancelledException?>()
        runBlocking {
            val job = CoroutineScope(Dispatchers.Default).launch {
                try {
                    loop.run("m", history, listener)
                } catch (e: RunCancelledException) {
                    captured.set(e)
                    throw e
                }
            }
            assertTrue("loop never reached the cancel point", ready.await(10, TimeUnit.SECONDS))
            job.cancel()
            withTimeout(10_000) { job.join() }
        }
        return captured.get() ?: throw AssertionError("no RunCancelledException captured")
    }

    @Test
    fun `cancel mid-stream keeps the partial reply`() {
        val streaming = CountDownLatch(1)
        val provider = scripted(listOf(ProviderEvent.TextDelta("par")))
        val loop = ToolLoop(provider, ToolRegistry(emptyList()), approve)
        val e = cancelWhen(loop, streaming, object : LoopListener {
            override fun onText(text: String) = streaming.countDown()
        })
        assertEquals(listOf(ChatMessage(Role.ASSISTANT, "par")), e.produced)
        assertEquals(history + e.produced, e.transcript)
        assertEquals(0, e.uncertainOutcomes)
    }

    @Test
    fun `cancel before any output produces nothing`() {
        val started = CountDownLatch(1)
        val provider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels() = emptyList<ModelInfo>()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                started.countDown()
                awaitCancellation()
            }
        }
        val e = cancelWhen(ToolLoop(provider, ToolRegistry(emptyList()), approve), started)
        assertTrue(e.produced.isEmpty())
    }

    @Test
    fun `cancel during a tool call marks it uncertain and the rest not executed`() {
        val inTool = CountDownLatch(1)
        val hanging = tool("hang") { inTool.countDown(); awaitCancellation() }
        val never = tool("never") { "x" }
        val provider = scripted(listOf(
            ProviderEvent.ToolCalls(listOf(call("c1", "hang"), call("c2", "never"))),
            ProviderEvent.Completed("tool_calls", null),
        ))
        val loop = ToolLoop(provider, ToolRegistry(listOf(hanging, never)), approve)
        val e = cancelWhen(loop, inTool)
        val tools = e.produced.filter { it.role == Role.TOOL }
        assertEquals(listOf("c1", "c2"), tools.map { it.toolCallId })
        assertTrue(tools[0].content.startsWith("Outcome uncertain:"))
        assertEquals("Not executed: cancelled by user", tools[1].content)
        assertEquals(1, e.uncertainOutcomes)
        // Every tool call has a result, so the transcript is valid to send to a provider again.
        assertEquals(Role.ASSISTANT, e.produced.first().role)
    }

    @Test
    fun `cancel while waiting for approval executes nothing`() {
        val asking = CountDownLatch(1)
        var executed = false
        val guarded = tool("edit", approval = true) { executed = true; "done" }
        val provider = scripted(listOf(
            ProviderEvent.ToolCalls(listOf(call("c1", "edit"))),
            ProviderEvent.Completed("tool_calls", null),
        ))
        val gate = ApprovalGate { _, _ -> asking.countDown(); awaitCancellation() }
        val e = cancelWhen(ToolLoop(provider, ToolRegistry(listOf(guarded)), gate), asking)
        assertTrue(!executed)
        assertEquals("Not executed: cancelled by user", e.produced.last().content)
        assertEquals(0, e.uncertainOutcomes)
    }

    @Test
    fun `usage is summed across model turns`() {
        val provider = scripted(
            listOf(
                ProviderEvent.ToolCalls(listOf(call("c1"))),
                ProviderEvent.Completed("tool_calls", Usage(10, 5, 0.01)),
            ),
            listOf(ProviderEvent.TextDelta("ok"), ProviderEvent.Completed("stop", Usage(3, 2, 0.02))),
        )
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(listOf(tool { "r" })), approve).run("m", history, object : LoopListener {})
        } as LoopResult.Completed
        assertEquals(13, r.usage?.promptTokens)
        assertEquals(7, r.usage?.completionTokens)
        assertEquals(0.03, r.usage!!.costUsd!!, 1e-9)
    }

    @Test
    fun `usage stays null when the provider reports none`() {
        val provider = scripted(listOf(ProviderEvent.TextDelta("ok"), ProviderEvent.Completed("stop", null)))
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(emptyList()), approve).run("m", history, object : LoopListener {})
        } as LoopResult.Completed
        assertNull(r.usage)
    }

    @Test
    fun `run cancelled exception exposes its cause`() {
        val cause = RuntimeException("x")
        val e = RunCancelledException(emptyList(), emptyList(), cause)
        assertNotNull(e.cause)
        assertEquals(0, e.uncertainOutcomes)
    }

    // --- usage and truncation-retry edge cases ---

    private val toolTurn = listOf(
        ProviderEvent.ToolCalls(listOf(call("c1"))),
        ProviderEvent.Completed("tool_calls", Usage(1, 1, 0.1)),
    )

    @Test
    fun `turn limit run still reports the usage it consumed`() {
        val r = runBlocking {
            ToolLoop(scripted(toolTurn, toolTurn, toolTurn), ToolRegistry(listOf(tool { "r" })), approve,
                LoopLimits(maxModelTurns = 2)).run("m", history, object : LoopListener {})
        } as LoopResult.TurnLimitReached
        assertEquals(2, r.usage?.promptTokens)
        assertEquals(0.2, r.usage!!.costUsd!!, 1e-9)
    }

    @Test
    fun `failed run still reports the usage it consumed`() {
        val truncated = listOf(ProviderEvent.TextDelta("cut"), ProviderEvent.Completed("length", Usage(5, 5, 0.3)))
        val r = runBlocking {
            ToolLoop(scripted(toolTurn, truncated), ToolRegistry(listOf(tool { "r" })), approve,
                LoopLimits(maxTruncationRetries = 0)).run("m", history, object : LoopListener {})
        } as LoopResult.Failed
        assertEquals("truncated", r.code)
        assertEquals(Usage(6, 6, 0.4).promptTokens, r.usage?.promptTokens)
        assertEquals(0.4, r.usage!!.costUsd!!, 1e-9)
    }

    @Test
    fun `cancelled run reports the usage already spent`() {
        val second = CountDownLatch(1)
        val provider = object : ModelProvider {
            override val id = "fake"
            var n = 0
            override suspend fun listModels() = emptyList<ModelInfo>()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                if (n++ == 0) {
                    toolTurn.forEach { emit(it) }
                } else {
                    second.countDown()
                    awaitCancellation()
                }
            }
        }
        val e = cancelWhen(ToolLoop(provider, ToolRegistry(listOf(tool { "r" })), approve), second)
        assertEquals(Usage(1, 1, 0.1), e.usage)
    }

    private val longHistory = (1..8).flatMap {
        listOf(ChatMessage(Role.USER, "question $it " + "x".repeat(200)), ChatMessage(Role.ASSISTANT, "answer $it " + "y".repeat(200)))
    } + ChatMessage(Role.USER, "latest")

    private fun summaryAware(
        summary: List<ProviderEvent>,
        main: List<ProviderEvent>,
        onSummary: () -> Unit = {},
    ) = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels() = emptyList<ModelInfo>()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            val isSummary = request.messages.any {
                it.role == Role.SYSTEM && it.content == com.aijb.assistant.chat.ContextCompactor.SUMMARY_PROMPT
            }
            return flow {
                if (isSummary) onSummary()
                (if (isSummary) summary else main).forEach { emit(it) }
                if ((if (isSummary) summary else main).isEmpty()) awaitCancellation()
            }
        }
    }

    @Test
    fun `compaction requests are counted in the usage`() {
        val provider = summaryAware(
            listOf(ProviderEvent.TextDelta("sum"), ProviderEvent.Completed("stop", Usage(100, 50, 0.5))),
            listOf(ProviderEvent.TextDelta("ok"), ProviderEvent.Completed("stop", Usage(10, 5, 0.1))),
        )
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(emptyList()), approve, LoopLimits(compactAtTokens = 1))
                .run("m", longHistory, object : LoopListener {})
        } as LoopResult.Completed
        assertEquals(110, r.usage?.promptTokens)
        assertEquals(55, r.usage?.completionTokens)
        assertEquals(0.6, r.usage!!.costUsd!!, 1e-9)
    }

    @Test
    fun `failed compaction still counts what the summary cost`() {
        val provider = summaryAware(
            listOf(ProviderEvent.TextDelta("sum"), ProviderEvent.Completed("length", Usage(100, 50, 0.5))),
            listOf(ProviderEvent.TextDelta("ok"), ProviderEvent.Completed("stop", Usage(10, 5, 0.1))),
        )
        val r = runBlocking {
            ToolLoop(provider, ToolRegistry(emptyList()), approve, LoopLimits(compactAtTokens = 1))
                .run("m", longHistory, object : LoopListener {})
        } as LoopResult.Completed
        assertEquals(110, r.usage?.promptTokens)
    }

    @Test
    fun `cancel while compacting after truncation does not resurrect the dropped reply`() {
        val summarising = CountDownLatch(1)
        val provider = summaryAware(
            emptyList(),
            listOf(ProviderEvent.TextDelta("truncated reply"), ProviderEvent.Completed("length", null)),
        ) { summarising.countDown() }
        val e = cancelWhen(ToolLoop(provider, ToolRegistry(emptyList()), approve), summarising, history = longHistory)
        assertTrue(e.produced.none { it.content.contains("truncated reply") })
    }
}

package com.aijb.assistant

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.RolePrompts
import com.aijb.assistant.chat.ChatHistoryStore
import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.chat.ContextCompactor
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolOutcome
import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.tools.ToolRegistry
import kotlinx.serialization.json.JsonObject
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

class ChatSessionTest : BasePlatformTestCase() {

    private lateinit var scope: CoroutineScope

    override fun setUp() {
        super.setUp()
        scope = CoroutineScope(SupervisorJob())
    }

    override fun tearDown() {
        try {
            scope.cancel()
        } finally {
            super.tearDown()
        }
    }

    private class RecordingListener : ChatListener {
        val deltas = StringBuilder()
        val completed = CountDownLatch(1)
        val failed = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        var failure: String? = null
        val compacted = mutableListOf<Pair<Int, Int>>()
        val compactionFailures = mutableListOf<String>()

        override fun onCompacted(beforeTokens: Int, afterTokens: Int) {
            compacted += beforeTokens to afterTokens
        }

        override fun onCompactionFailed(message: String) {
            compactionFailures += message
        }

        val toolCalls = mutableListOf<String>()
        val toolOutcomes = mutableListOf<ToolOutcome>()
        val levels = mutableListOf<AgentRole>()
        val levelContexts = mutableListOf<String>()

        override fun onLevelStarted(role: AgentRole, context: String) {
            levels += role
            levelContexts += context
        }

        override fun onToolRequested(call: ToolCall) {
            toolCalls += call.name
        }

        override fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) {
            toolOutcomes += outcome
        }

        override fun onDelta(text: String) {
            deltas.append(text)
        }

        override fun onCompleted(usage: Usage?) {
            completed.countDown()
        }

        override fun onFailed(message: String) {
            failure = message
            failed.countDown()
        }

        override fun onCancelled() {
            cancelled.countDown()
        }

        var failureCode: String? = null
        var uncertain: Int = -1

        override fun onFailedWithCode(message: String, code: String?) {
            failureCode = code
            onFailed(message)
        }

        override fun onCancelledWithOutcomes(uncertainOutcomes: Int) {
            uncertain = uncertainOutcomes
            onCancelled()
        }
    }

    private fun fakeProvider(id: String = "fake", vararg events: ProviderEvent) = object : ModelProvider {
        override val id = id
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            events.forEach { emit(it) }
        }
    }

    private fun newSession(): ChatSession =
        ChatSession(project, scope).also { it.tools = { ToolRegistry(emptyList()) } }

    private fun pumpUntil(latch: CountDownLatch, timeoutMs: Long = 10_000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (latch.await(20, TimeUnit.MILLISECONDS)) return true
        }
        return false
    }

    fun `test completed turn appends user and assistant`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake",
            ProviderEvent.TextDelta("he"),
            ProviderEvent.TextDelta("llo"),
            ProviderEvent.Completed("stop", Usage(1, 2)),
        )) }
        val listener = RecordingListener()
        val job = session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        runUntilIdle { job.isCompleted }
        assertEquals("hello", listener.deltas.toString())
        assertEquals(2, session.transcript.size)
        assertEquals(Role.USER, session.transcript[0].role)
        assertEquals("hi", session.transcript[0].content)
        assertEquals(Role.ASSISTANT, session.transcript[1].role)
        assertEquals("hello", session.transcript[1].content)
    }

    fun `test cancel mid stream does not append assistant`() {
        val session = newSession()
        session.providers = { listOf(object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                emit(ProviderEvent.TextDelta("partial"))
                while (true) {
                    delay(20)
                    emit(ProviderEvent.TextDelta("."))
                }
            }
        }) }
        val listener = RecordingListener()
        val job = session.send("hi", ModelRef("fake", "m"), listener)
        Thread.sleep(300)
        pumpUntil(CountDownLatch(1), 100)
        session.cancel()
        assertTrue(pumpUntil(listener.cancelled))
        // User turn kept; partial reply is kept with an interruption marker.
        assertEquals(2, session.transcript.size)
        assertEquals(Role.USER, session.transcript[0].role)
        assertEquals(Role.ASSISTANT, session.transcript[1].role)
        assertTrue(session.transcript[1].content.startsWith("partial"))
        assertTrue(session.transcript[1].content.endsWith(ChatSession.CANCEL_MARKER))
        assertTrue(job.isCancelled || job.isCompleted)
    }

    fun `test failure does not append assistant`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake",
            ProviderEvent.TextDelta("partial"),
            ProviderEvent.Failed("boom"),
        )) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("boom", listener.failure)
        assertEquals(1, session.transcript.size)
    }

    fun `test send while active cancels previous job`() {
        val session = newSession()
        session.providers = { listOf(object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                while (true) {
                    delay(20)
                    emit(ProviderEvent.TextDelta("."))
                }
            }
        }) }
        val first = RecordingListener()
        val firstJob = session.send("one", ModelRef("fake", "m"), first)
        Thread.sleep(200)
        val second = RecordingListener()
        val secondJob = session.send("two", ModelRef("fake", "m"), second)
        assertTrue(pumpUntil(first.cancelled))
        assertTrue(firstJob.isCancelled || firstJob.isCompleted)
        session.cancel()
        assertTrue(pumpUntil(second.cancelled))
        assertTrue(secondJob.isCancelled || secondJob.isCompleted)
        assertEquals(3, session.transcript.size)
        assertEquals("one", session.transcript[0].content)
        assertEquals("two", session.transcript[1].content)
        assertEquals(ChatSession.CANCEL_MARKER, session.transcript[2].content.lines().last())
    }

    fun `test transcript snapshot is immutable`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake",
            ProviderEvent.TextDelta("x"),
            ProviderEvent.Completed("stop", null),
        )) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        val snapshot = session.transcript
        val size = snapshot.size
        session.send("second", ModelRef("fake", "m"), RecordingListener())
        assertEquals(size, snapshot.size)
    }

    fun `test completed with empty reply appends nothing`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.Completed("stop", null))) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(1, session.transcript.size)
    }

    fun `test provider exception leaves transcript with user only`() {
        val session = newSession()
        session.providers = { listOf(object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                throw RuntimeException("stream broke")
            }
        }) }
        val listener = RecordingListener()
        val job = session.send("hi", ModelRef("fake", "m"), listener)
        runUntilIdle { job.isCompleted }
        assertEquals(1, session.transcript.size)
    }

    fun `test send routes to provider by ref`() {
        val session = newSession()
        val used = mutableListOf<String>()
        fun recording(id: String) = object : ModelProvider {
            override val id = id
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                used += "$id:${request.model}"
                emit(ProviderEvent.Completed("stop", null))
            }
        }
        session.providers = { listOf(recording("p1"), recording("p2")) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("p2", "m9"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(listOf("p2:m9"), used)
    }

    fun `test unknown provider fails without reply`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.Completed("stop", null))) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("ghost", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("Provider not configured: ghost", listener.failure)
        assertEquals(1, session.transcript.size)
        assertEquals(Role.USER, session.transcript[0].role)
    }

    private fun summaryAware(
        summaryEvents: List<ProviderEvent>,
        mainEvents: List<ProviderEvent>,
        id: String = "fake",
    ) = object : ModelProvider {
        override val id = id
        val requests = mutableListOf<ChatRequest>()
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            requests += request
            val isSummary = request.messages.any {
                it.role == Role.SYSTEM && it.content == ContextCompactor.SUMMARY_PROMPT
            }
            return flow { (if (isSummary) summaryEvents else mainEvents).forEach { emit(it) } }
        }
    }

    private fun seedTranscript(session: ChatSession) {
        val provider = summaryAware(
            emptyList(),
            listOf(ProviderEvent.TextDelta("a".repeat(40)), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        repeat(6) {
            val l = RecordingListener()
            session.send("q$it " + "x".repeat(40), ModelRef("fake", "m"), l)
            pumpUntil(l.completed)
        }
        session.providers = { emptyList() }
    }

    fun `test compaction replaces transcript and request uses compacted history`() {
        val session = newSession()
        session.autoCompactTokens = { 100_000 }
        seedTranscript(session)
        session.autoCompactTokens = { 1 }
        val provider = summaryAware(
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
            listOf(ProviderEvent.TextDelta("reply"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        val job = session.send("next", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        runUntilIdle { job.isCompleted }
        assertEquals(1, listener.compacted.size)
        assertEquals(2, provider.requests.size)
        assertTrue(provider.requests[1].messages.any {
            it.content.startsWith(ContextCompactor.SUMMARY_PREFIX)
        })
        assertTrue(provider.requests[1].messages.none { it.content.startsWith("q0 ") })
        assertTrue(session.transcript.any {
            it.content.startsWith(ContextCompactor.SUMMARY_PREFIX)
        })
        assertTrue(session.transcript.none { it.content.startsWith("q0 ") })
    }

    fun `test compaction failure keeps full history and notifies`() {
        val session = newSession()
        session.autoCompactTokens = { 100_000 }
        seedTranscript(session)
        session.autoCompactTokens = { 1 }
        val provider = summaryAware(
            listOf(ProviderEvent.Failed("no summary")),
            listOf(ProviderEvent.TextDelta("reply"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("next", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(listOf("no summary"), listener.compactionFailures)
        assertTrue(listener.compacted.isEmpty())
        assertTrue(provider.requests[1].messages.any { it.content.startsWith("q0 ") })
    }

    fun `test last prompt tokens triggers compaction on next send`() {
        val session = newSession()
        session.autoCompactTokens = { 100_000 }
        seedTranscript(session)
        val provider = summaryAware(
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
            listOf(ProviderEvent.TextDelta("r"), ProviderEvent.Completed("stop", Usage(200_000, 1))),
        )
        session.providers = { listOf(provider) }
        val first = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), first)
        assertTrue(pumpUntil(first.completed))
        assertEquals(1, provider.requests.size)
        assertTrue(first.compacted.isEmpty())
        val second = RecordingListener()
        session.send("again", ModelRef("fake", "m"), second)
        assertTrue(pumpUntil(second.completed))
        assertEquals(3, provider.requests.size)
        assertEquals(1, second.compacted.size)
    }

    private fun levelRouted(providerId: String = "fake") = object : ModelProvider {
        override val id = providerId
        val requests = mutableListOf<ChatRequest>()
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            requests += request
            val sys = request.messages.firstOrNull { it.role == Role.SYSTEM }?.content.orEmpty()
            val evs = when {
                sys.contains("submit_plan") -> listOf(
                    ProviderEvent.NativeToolCalls(listOf(
                        com.aijb.assistant.provider.RawToolCall(
                            "p1", "submit_plan",
                            """{"goal":"g","milestones":[{"id":1,"title":"m1","notes":"n"}]}""",
                        ),
                    )),
                    ProviderEvent.Completed("tool_calls", null),
                )
                sys.contains("submit_tasks") -> listOf(
                    ProviderEvent.NativeToolCalls(listOf(
                        com.aijb.assistant.provider.RawToolCall("e1", "complete_milestone", """{"notes":"ok"}"""),
                    )),
                    ProviderEvent.Completed("tool_calls", null),
                )
                else -> listOf(ProviderEvent.Completed("stop", null))
            }
            return flow { evs.forEach { emit(it) } }
        }
    }

    fun `test multi model runs orchestrator end to end`() {
        val session = newSession()
        session.multiModel = { true }
        val provider = levelRouted()
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(listOf(AgentRole.PLANNER, AgentRole.EXECUTOR), listener.levels)
        // Role prompts are injected per request and never stored.
        assertTrue(session.transcript.none { it.role == Role.SYSTEM })
        assertEquals(Role.USER, session.transcript.first().role)
        assertTrue(session.transcript.last().content.startsWith("Done. Goal: g"))
        // First request is the Planner level.
        val plannerSys = provider.requests[0].messages.first { it.role == Role.SYSTEM }.content
        assertTrue(plannerSys.startsWith(RolePrompts.forRole(AgentRole.PLANNER)))
    }

    fun `test multi model routes each level to its configured provider`() {
        val session = newSession()
        session.multiModel = { true }
        val planner = levelRouted("p1")
        val executor = levelRouted("p2")
        session.providers = { listOf(planner, executor) }
        session.roleModels = {
            mapOf(
                AgentRole.PLANNER to ModelRef("p1", "big"),
                AgentRole.EXECUTOR to ModelRef("p2", "small"),
                AgentRole.WORKER to null,
            )
        }
        val listener = RecordingListener()
        session.send("hi", ModelRef("p1", "big"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(1, planner.requests.size)
        assertEquals(1, executor.requests.size)
        assertEquals("small", executor.requests[0].model)
        // Destination is shown on the level header before dispatch.
        assertEquals(
            listOf(true, true),
            listOf(listener.levelContexts[0].endsWith("→ p1/big"), listener.levelContexts[1].endsWith("→ p2/small")),
        )
    }

    fun `test multi model missing role provider fails without fallback`() {
        val session = newSession()
        session.multiModel = { true }
        val local = levelRouted("ollama")
        session.providers = { listOf(local) }
        session.roleModels = {
            mapOf(
                AgentRole.PLANNER to ModelRef("ollama", "q"),
                AgentRole.EXECUTOR to ModelRef("claude", "opus"),
                AgentRole.WORKER to null,
            )
        }
        val listener = RecordingListener()
        session.send("hi", ModelRef("ollama", "q"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("Provider not configured for executor: claude", listener.failure)
        assertTrue(local.requests.isEmpty())
    }

    fun `test multi model orchestrator failure is surfaced`() {
        val session = newSession()
        session.multiModel = { true }
        val provider = summaryAware(
            emptyList(),
            listOf(ProviderEvent.TextDelta("hmm"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertTrue(listener.failure!!.contains("Planner"))
        assertTrue(session.transcript.none { it.role == Role.SYSTEM })
    }

    fun `test single model sends no role prompt`() {
        val session = newSession()
        session.multiModel = { false }
        val provider = summaryAware(
            emptyList(),
            listOf(ProviderEvent.TextDelta("r"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertTrue(provider.requests[0].messages.none {
            it.content.contains("You are one of three roles")
        })
    }

    fun `test multi model compaction summary has no role prompt`() {
        val session = newSession()
        session.autoCompactTokens = { 100_000 }
        seedTranscript(session)
        session.autoCompactTokens = { 1 }
        session.multiModel = { true }
        // Planner stalls with text-only turns; the assertions concern the first two requests.
        val provider = summaryAware(
            listOf(ProviderEvent.TextDelta("- sum"), ProviderEvent.Completed("stop", null)),
            listOf(ProviderEvent.TextDelta("hmm"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("next", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertTrue(listener.failure!!.contains("Planner"))
        // The compaction summary request carries no role prompt.
        assertTrue(provider.requests[0].messages.none {
            it.content.contains("You are one of three roles")
        })
        // The Planner level request does.
        val plannerReq = provider.requests[1]
        assertEquals(Role.SYSTEM, plannerReq.messages[0].role)
        assertTrue(plannerReq.messages[0].content.startsWith(RolePrompts.forRole(AgentRole.PLANNER)))
    }

    private fun scripted(id: String = "fake", vararg responses: List<ProviderEvent>) =
        object : ModelProvider {
            override val id = id
            val requests = mutableListOf<ChatRequest>()
            var calls = 0
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> {
                requests += request
                val evs = responses.getOrElse(calls++) { listOf(ProviderEvent.Completed("stop", null)) }
                return flow { evs.forEach { emit(it) } }
            }
        }

    private fun fakeTool(name: String = "t", result: String = "T-RESULT", onRun: () -> Unit = {}) =
        object : Tool {
            override val spec = ToolSpec(name, "d", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
                onRun()
                return result
            }
        }

    fun `test tool call executes and result fed back`() {
        val session = newSession()
        session.tools = { ToolRegistry(listOf(fakeTool())) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        val provider = scripted("fake",
            listOf(
                ProviderEvent.NativeToolCalls(listOf(
                    com.aijb.assistant.provider.RawToolCall("c1", "t", "{}"))),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("ans"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("go", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(listOf("t"), listener.toolCalls)
        assertTrue(listener.toolOutcomes.any { it is ToolOutcome.Success })
        assertTrue(session.transcript.any { it.role == Role.TOOL && it.content == "T-RESULT" })
        assertEquals(2, provider.requests.size)
        assertTrue(provider.requests[1].messages.any { it.content.contains("T-RESULT") })
    }

    fun `test turn limit fails with message`() {
        val session = newSession()
        session.tools = { ToolRegistry(listOf(fakeTool())) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        val provider = scripted("fake",
            *(1..30).map {
                listOf<ProviderEvent>(
                    ProviderEvent.NativeToolCalls(listOf(
                        com.aijb.assistant.provider.RawToolCall("c$it", "t", "{}"))),
                    ProviderEvent.Completed("tool_calls", null),
                )
            }.toTypedArray(),
        )
        session.providers = { listOf(provider) }
        val listener = RecordingListener()
        session.send("go", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("Stopped: tool-turn limit reached (25)", listener.failure)
    }

    // --- M8: error codes, cancellation transcript, usage totals, persistence ---

    fun `test provider failure code reaches the listener`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.Failed("nope", code = "auth"))) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("auth", listener.failureCode)
        assertEquals("nope", listener.failure)
    }

    fun `test missing provider and turn limit carry codes`() {
        val session = newSession()
        session.providers = { emptyList() }
        val l1 = RecordingListener()
        session.send("hi", ModelRef("ghost", "m"), l1)
        assertTrue(pumpUntil(l1.failed))
        assertEquals("provider_missing", l1.failureCode)

        val s2 = newSession()
        s2.tools = { ToolRegistry(listOf(fakeTool())) }
        s2.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        s2.providers = { listOf(scripted("fake", *(1..30).map {
            listOf<ProviderEvent>(
                ProviderEvent.NativeToolCalls(listOf(com.aijb.assistant.provider.RawToolCall("c$it", "t", "{}"))),
                ProviderEvent.Completed("tool_calls", null),
            )
        }.toTypedArray())) }
        val l2 = RecordingListener()
        s2.send("go", ModelRef("fake", "m"), l2)
        assertTrue(pumpUntil(l2.failed))
        assertEquals("turn_limit", l2.failureCode)
    }

    fun `test multi model failure keeps the provider code`() {
        val session = newSession()
        session.multiModel = { true }
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.Failed("denied", code = "rate_limited"))) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("rate_limited", listener.failureCode)
    }

    fun `test cancel during a tool call keeps the result and reports it uncertain`() {
        val session = newSession()
        val inTool = CountDownLatch(1)
        session.tools = { ToolRegistry(listOf(object : Tool {
            override val spec = ToolSpec("t", "d", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
                inTool.countDown()
                kotlinx.coroutines.awaitCancellation()
            }
        })) }
        session.providers = { listOf(scripted("fake", listOf(
            ProviderEvent.NativeToolCalls(listOf(com.aijb.assistant.provider.RawToolCall("c1", "t", "{}"))),
            ProviderEvent.Completed("tool_calls", null),
        ))) }
        val listener = RecordingListener()
        session.send("go", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(inTool))
        session.cancel()
        assertTrue(pumpUntil(listener.cancelled))
        assertEquals(1, listener.uncertain)
        val t = session.transcript
        assertEquals(listOf(Role.USER, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT), t.map { it.role })
        assertTrue(t[2].content.startsWith("Outcome uncertain:"))
        assertEquals(ChatSession.CANCEL_MARKER, t[3].content)
    }

    fun `test cancel in multi model mode keeps the partial level output`() {
        val session = newSession()
        session.multiModel = { true }
        val streaming = CountDownLatch(1)
        session.providers = { listOf(object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                emit(ProviderEvent.TextDelta("thinking"))
                streaming.countDown()
                kotlinx.coroutines.awaitCancellation()
            }
        }) }
        val listener = RecordingListener()
        session.send("plan it", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(streaming))
        session.cancel()
        assertTrue(pumpUntil(listener.cancelled))
        val t = session.transcript
        assertEquals("plan it", t[0].content)
        assertTrue(t.last().content.startsWith("thinking"))
        assertTrue(t.last().content.endsWith(ChatSession.CANCEL_MARKER))
        assertTrue(t.none { it.role == Role.SYSTEM })
    }

    fun `test cancel marker is appended or merged`() {
        val user = ChatMessage(Role.USER, "q")
        assertEquals(
            listOf(user, ChatMessage(Role.ASSISTANT, ChatSession.CANCEL_MARKER)),
            ChatSession.withCancelMarker(listOf(user)),
        )
        assertEquals(
            listOf(user, ChatMessage(Role.ASSISTANT, "part\n" + ChatSession.CANCEL_MARKER)),
            ChatSession.withCancelMarker(listOf(user, ChatMessage(Role.ASSISTANT, "part"))),
        )
        assertEquals(ChatMessage(Role.ASSISTANT, ChatSession.CANCEL_MARKER), ChatSession.withCancelMarker(emptyList()).single())
    }

    private fun tempStore(): ChatHistoryStore =
        ChatHistoryStore(ChatHistoryStore.pathFor(java.nio.file.Files.createTempDirectory("aijb-sess-"), "p"))

    private fun sendAndWait(session: ChatSession, text: String) {
        val listener = RecordingListener()
        val job = session.send(text, ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(listener.completed))
        runUntilIdle { job.isCompleted }
    }

    fun `test session usage sums across requests`() {
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake",
            ProviderEvent.TextDelta("a"), ProviderEvent.Completed("stop", Usage(10, 5, 0.5)))) }
        assertNull(session.sessionUsage)
        sendAndWait(session, "one")
        sendAndWait(session, "two")
        assertEquals(Usage(20, 10, 1.0), session.sessionUsage)
    }

    fun `test history is saved after a turn and restored by a new session`() {
        val store = tempStore()
        val session = newSession()
        session.historyStore = store
        session.historyRetentionDays = { 30 }
        session.providers = { listOf(fakeProvider("fake",
            ProviderEvent.TextDelta("answer"), ProviderEvent.Completed("stop", Usage(4, 2, 0.1)))) }
        sendAndWait(session, "question")
        runUntilIdle { java.nio.file.Files.exists(store.file) }

        val restored = newSession()
        restored.historyStore = store
        restored.historyRetentionDays = { 30 }
        restored.restoreHistory()
        assertEquals(session.transcript, restored.transcript)
        assertEquals(Usage(4, 2, 0.1), restored.sessionUsage)
    }

    fun `test restore does not overwrite a non-empty chat`() {
        val store = tempStore()
        store.save(listOf(ChatMessage(Role.USER, "old")), null)
        val session = newSession()
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.Completed("stop", null))) }
        sendAndWait(session, "new")
        session.historyStore = store
        session.historyRetentionDays = { 30 }
        session.restoreHistory()
        assertEquals("new", session.transcript.first().content)
    }

    fun `test zero retention saves nothing and removes the file`() {
        val store = tempStore()
        store.save(listOf(ChatMessage(Role.USER, "old")), null)
        val session = newSession()
        session.historyStore = store
        session.historyRetentionDays = { 0 }
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.TextDelta("a"), ProviderEvent.Completed("stop", null))) }
        sendAndWait(session, "q")
        runUntilIdle { !java.nio.file.Files.exists(store.file) }
        session.restoreHistory()
        assertEquals(2, session.transcript.size)
    }

    fun `test clear history wipes memory usage and file`() {
        val store = tempStore()
        val session = newSession()
        session.historyStore = store
        session.historyRetentionDays = { 30 }
        session.providers = { listOf(fakeProvider("fake",
            ProviderEvent.TextDelta("a"), ProviderEvent.Completed("stop", Usage(1, 1, 0.1)))) }
        sendAndWait(session, "q")
        runUntilIdle { java.nio.file.Files.exists(store.file) }
        session.clearHistory()
        assertTrue(session.transcript.isEmpty())
        assertNull(session.sessionUsage)
        assertFalse(java.nio.file.Files.exists(store.file))
    }

    fun `test clear history cancels a running request`() {
        val session = newSession()
        val streaming = CountDownLatch(1)
        session.providers = { listOf(object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                streaming.countDown()
                kotlinx.coroutines.awaitCancellation()
            }
        }) }
        val listener = RecordingListener()
        session.send("hi", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(streaming))
        session.clearHistory()
        assertTrue(pumpUntil(listener.cancelled))
        assertTrue(session.transcript.isEmpty())
    }

    fun `test storage failures never break the chat`() {
        val failing = object : ChatHistoryStore(java.nio.file.Files.createTempDirectory("aijb-f-").resolve("h.json")) {
            override fun save(messages: List<ChatMessage>, usage: Usage?, now: Long) = throw java.io.IOException("disk full")
            override fun load(retentionDays: Int, now: Long): com.aijb.assistant.chat.LoadedChat? = throw java.io.IOException("unreadable")
            override fun delete() = throw java.io.IOException("locked")
        }
        val session = newSession()
        session.historyStore = failing
        session.historyRetentionDays = { 30 }
        session.providers = { listOf(fakeProvider("fake", ProviderEvent.TextDelta("a"), ProviderEvent.Completed("stop", null))) }
        session.restoreHistory()
        sendAndWait(session, "q")
        assertEquals(2, session.transcript.size)
        session.historyRetentionDays = { 0 }
        session.dispose()
        session.clearHistory()
        assertTrue(session.transcript.isEmpty())
    }

    private fun runUntilIdle(cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (cond()) return
            Thread.sleep(20)
        }
        fail("condition not met")
    }

    fun `test cancelled and failed runs still count their usage`() {
        val session = newSession()
        val inTool = CountDownLatch(1)
        session.tools = { ToolRegistry(listOf(object : Tool {
            override val spec = ToolSpec("t", "d", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
                inTool.countDown()
                kotlinx.coroutines.awaitCancellation()
            }
        })) }
        session.providers = { listOf(scripted("fake", listOf(
            ProviderEvent.NativeToolCalls(listOf(com.aijb.assistant.provider.RawToolCall("c1", "t", "{}"))),
            ProviderEvent.Completed("tool_calls", Usage(4, 2, 0.1)),
        ))) }
        val listener = RecordingListener()
        session.send("go", ModelRef("fake", "m"), listener)
        assertTrue(pumpUntil(inTool))
        session.cancel()
        assertTrue(pumpUntil(listener.cancelled))
        assertEquals(Usage(4, 2, 0.1), session.sessionUsage)

        val s2 = newSession()
        s2.providers = { listOf(fakeProvider("fake", ProviderEvent.Failed("x", code = "auth"))) }
        val l2 = RecordingListener()
        s2.send("go", ModelRef("fake", "m"), l2)
        assertTrue(pumpUntil(l2.failed))
        assertNull(s2.sessionUsage)

        val s3 = newSession()
        s3.tools = { ToolRegistry(listOf(fakeTool())) }
        s3.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        s3.providers = { listOf(scripted("fake", *(1..30).map {
            listOf<ProviderEvent>(
                ProviderEvent.NativeToolCalls(listOf(com.aijb.assistant.provider.RawToolCall("c$it", "t", "{}"))),
                ProviderEvent.Completed("tool_calls", Usage(1, 1, 0.01)),
            )
        }.toTypedArray())) }
        val l3 = RecordingListener()
        s3.send("go", ModelRef("fake", "m"), l3)
        assertTrue(pumpUntil(l3.failed))
        assertEquals(25, s3.sessionUsage?.promptTokens)
    }
}

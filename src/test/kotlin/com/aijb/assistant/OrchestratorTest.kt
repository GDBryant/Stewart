package com.aijb.assistant

import org.junit.Assert.assertNull
import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.LevelRoute
import com.aijb.assistant.agents.OrchestrationResult
import com.aijb.assistant.agents.Orchestrator
import com.aijb.assistant.agents.OrchestratorLimits
import com.aijb.assistant.agents.OrchestratorListener
import com.aijb.assistant.agents.Plan
import com.aijb.assistant.agents.Protocol
import com.aijb.assistant.agents.RolePrompts
import com.aijb.assistant.agents.RoleRouting
import com.aijb.assistant.agents.WorkerResult
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.RawToolCall
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.shim.ToolCallingProvider
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.tools.ToolRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds

class OrchestratorTest {

    private lateinit var scope: CoroutineScope

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob())
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    @JvmName("queueOne")
    private fun ArrayDeque<List<ProviderEvent>>.plusAssign(event: List<ProviderEvent>) { addLast(event) }
    @JvmName("queueMany")
    private fun ArrayDeque<List<ProviderEvent>>.plusAssign(events: List<List<ProviderEvent>>) { addAll(events) }

    private class RecordingListener : OrchestratorListener {
        val deltas = StringBuilder()
        val levels = mutableListOf<Pair<AgentRole, String>>()
        var plan: Plan? = null
        val taskRounds = mutableListOf<List<String>>()
        val results = mutableListOf<WorkerResult>()
        val replans = mutableListOf<String>()
        var completed: Usage? = null
        var failed: String? = null

        override fun onDelta(text: String) { deltas.append(text) }
        override fun onLevelStarted(role: AgentRole, context: String) { levels += role to context }
        override fun onPlan(plan: Plan) { this.plan = plan }
        override fun onTasks(taskRound: Int, tasks: List<com.aijb.assistant.agents.DispatchTask>) {
            taskRounds += tasks.map { "${taskRound}:${it.id}" }
        }
        override fun onResult(result: WorkerResult) { results += result }
        override fun onReplanning(reason: String) { replans += reason }
        override fun onCompleted(usage: Usage?) { completed = usage }
        override fun onFailed(message: String) { failed = message }
    }

    private class ScriptedProvider : ModelProvider {
        override val id = "fake"
        val requests = mutableListOf<ChatRequest>()
        val planner = ArrayDeque<List<ProviderEvent>>()
        val executor = ArrayDeque<List<ProviderEvent>>()
        val worker = ArrayDeque<List<ProviderEvent>>()
        var workerHook: ((ChatRequest, Flow<ProviderEvent>) -> Flow<ProviderEvent>)? = null

        override suspend fun listModels(): List<ModelInfo> = emptyList()

        // In SHIM mode the wrapper strips tools from the inner request, so route by the
        // system prompt: each level's protocol block names its own submit tool.
        fun levelOf(request: ChatRequest): String =
            request.messages.firstOrNull { it.role == Role.SYSTEM }?.content.orEmpty()

        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            requests += request
            val level = levelOf(request)
            val queue = when {
                level.contains(Protocol.SUBMIT_PLAN) -> planner
                level.contains(Protocol.SUBMIT_TASKS) -> executor
                level.contains(Protocol.SUBMIT_RESULT) -> worker
                else -> error("unroutable request")
            }
            val evs = queue.removeFirstOrNull() ?: error("script exhausted for $level")
            val base = flow { evs.forEach { emit(it) } }
            return workerHook?.invoke(request, base) ?: base
        }
    }

    private fun call(name: String, id: String, args: String, usage: Usage? = Usage(10, 5)): List<ProviderEvent> =
        listOf(
            ProviderEvent.NativeToolCalls(listOf(RawToolCall(id, name, args))),
            ProviderEvent.Completed("tool_calls", usage),
        )

    private fun text(s: String, usage: Usage? = Usage(10, 5)): List<ProviderEvent> =
        listOf(ProviderEvent.TextDelta(s), ProviderEvent.Completed("stop", usage))

    private val planArgs =
        """{"goal":"ship it","milestones":[{"id":1,"title":"m1","notes":"n1"},{"id":2,"title":"m2","notes":"n2"}]}"""

    private fun oneMilestonePlan(id: Int = 1) =
        """{"goal":"ship it","milestones":[{"id":$id,"title":"m$id","notes":"n"}]}"""

    private fun fakeReadTool(name: String = "read_file") = object : Tool {
        override val spec = ToolSpec(name, "d", JsonObject(emptyMap()))
        override val requiresApproval = false
        override suspend fun execute(arguments: JsonObject, preview: ToolPreview?) = "FILE CONTENT"
    }

    private fun newOrchestrator(
        provider: ScriptedProvider,
        limits: OrchestratorLimits = OrchestratorLimits(),
    ) = Orchestrator(
        routes = RoleRouting.uniform(
            LevelRoute(
                ModelRef(provider.id, "llama"),
                ToolCallingProvider(provider, com.aijb.assistant.provider.ToolPath.SHIM),
            )
        ),
        projectTools = { ToolRegistry(listOf(fakeReadTool())) },
        approval = ApprovalGate { _, _ -> ApprovalDecision.Approved },
        limits = limits,
    )

    private fun plan(id: Int = 1, n: Int = 1): String {
        val ms = (id until id + n)
            .joinToString(",") { """{"id":$it,"title":"m$it","notes":"n"}""" }
        return """{"goal":"ship it","milestones":[$ms]}"""
    }

    private fun tasks(vararg ids: Int): String {
        val ts = ids.joinToString(",") { """{"id":$it,"description":"t$it"}""" }
        return """{"tasks":[$ts]}"""
    }

    private fun result(id: Int, status: String = "done", summary: String = "ok"): String =
        """{"task_id":$id,"status":"$status","summary":"$summary"}"""

    /** One milestone's happy path: executor dispatch, worker works, executor completes. */
    private fun milestoneScript(
        taskId: Int,
        workerUsesTool: Boolean = true,
    ): Pair<MutableList<List<ProviderEvent>>, MutableList<List<ProviderEvent>>> {
        val exec = mutableListOf<List<ProviderEvent>>()
        val work = mutableListOf<List<ProviderEvent>>()
        exec += call(Protocol.SUBMIT_TASKS, "e${taskId}a", tasks(taskId))
        if (workerUsesTool) {
            work += call("read_file", "w${taskId}a", """{"path":"a"}""")
        }
        work += call(Protocol.SUBMIT_RESULT, "w${taskId}b", result(taskId))
        exec += call(Protocol.COMPLETE_MILESTONE, "e${taskId}b", """{"notes":"done"}""")
        return exec to work
    }

    @Test
    fun `two milestone run flows planner executor worker per level`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", planArgs)
        val (m1e, m1w) = milestoneScript(1)
        val (m2e, m2w) = milestoneScript(2, workerUsesTool = false)
        p.executor += m1e; p.worker += m1w
        p.executor += m2e; p.worker += m2w

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("do the thing", listener) }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(2, listener.plan?.milestones?.size)
        assertEquals(
            listOf(
                AgentRole.PLANNER to "plan",
                AgentRole.EXECUTOR to "milestone 'm1' (1), round 1",
                AgentRole.WORKER to "milestone 'm1' (1), task 1: t1",
                AgentRole.WORKER to "task 1",
                AgentRole.EXECUTOR to "milestone 'm1' (1), round 2",
                AgentRole.EXECUTOR to "milestone 'm2' (2), round 1",
                AgentRole.WORKER to "milestone 'm2' (2), task 2: t2",
                AgentRole.WORKER to "task 2",
                AgentRole.EXECUTOR to "milestone 'm2' (2), round 2",
            ),
            listener.levels,
        )
        assertEquals(listOf(listOf("1:1"), listOf("1:2")), listener.taskRounds)
        assertEquals(
            listOf(WorkerResult(1, "done", "ok"), WorkerResult(2, "done", "ok")),
            listener.results,
        )
        // Seven level runs of 10/5, plus a second turn in the worker that uses a tool.
        assertEquals(Usage(80, 40), listener.completed)
        // Final summary message + no re-plans.
        val messages = (r as OrchestrationResult.Completed).messages
        assertEquals("Done. Goal: ship it\n- [1] m1: done\n- [2] m2: done\n", messages.last().content)
        assertEquals(0, r.replans.size)
        // The worker round for m1 actually used the project tool.
        val workerReqs = p.requests.filter { p.levelOf(it).contains(Protocol.SUBMIT_RESULT) }
        // w1a (project tool), w1b (submit), w2b (submit).
        assertEquals(3, workerReqs.size)
        assertTrue(messages.any { it.role == Role.TOOL && it.content == "FILE CONTENT" })
    }

    @Test
    fun `failed task makes executor dispatch a corrected round`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", result(1, "failed", "boom"))
        p.executor += call(Protocol.SUBMIT_TASKS, "e1b", tasks(2))
        p.worker += call(Protocol.SUBMIT_RESULT, "w2a", result(2, "done", "fixed"))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1c", """{"notes":"verified"}""")

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(listOf(listOf("1:1"), listOf("2:2")), listener.taskRounds)
        assertEquals(
            listOf(WorkerResult(1, "failed", "boom"), WorkerResult(2, "done", "fixed")),
            listener.results,
        )
        // Executor-level re-dispatch is not a Planner re-plan.
        assertEquals(0, listener.replans.size)
        // Round 2 saw the failed worker result.
        val round2 = p.requests[3]
        assertTrue(round2.messages.any { it.content.contains("task 1 [failed]: boom") })
    }

    @Test
    fun `unmet milestone triggers bounded planner re-plan then budget failure`() {
        val p = ScriptedProvider()
        // maxReplans = 2: the first failure triggers one re-plan, the second hits the budget.
        val limits = OrchestratorLimits(maxTaskRounds = 2, maxReplans = 2)
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan(1))
        // Milestone 1 fails both rounds.
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", result(1, "failed", "boom"))
        p.executor += call(Protocol.SUBMIT_TASKS, "e1b", tasks(2))
        p.worker += call(Protocol.SUBMIT_RESULT, "w2a", result(2, "failed", "boom again"))
        // Planner re-plan: same milestone, corrected.
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan(1))
        // Corrected milestone fails both rounds as well -> budget exhausted.
        p.executor += call(Protocol.SUBMIT_TASKS, "e2a", tasks(3))
        p.worker += call(Protocol.SUBMIT_RESULT, "w3a", result(3, "failed", "still"))
        p.executor += call(Protocol.SUBMIT_TASKS, "e2b", tasks(4))
        p.worker += call(Protocol.SUBMIT_RESULT, "w4a", result(4, "failed", "still"))

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p, limits).run("go", listener) }

        assertTrue(r is OrchestrationResult.Failed)
        assertEquals(
            "re-planning budget exhausted: milestone 'm1' (1) not met after 2 task rounds",
            (r as OrchestrationResult.Failed).message,
        )
        assertEquals(2, listener.replans.size)
        // One initial plan plus one re-plan.
        assertEquals(2, p.requests.count { p.levelOf(it).contains(Protocol.SUBMIT_PLAN) })
    }

    @Test
    fun `malformed worker result is retried inside the worker level`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        // Missing required 'status' -> schema invalid -> fed back.
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", """{"task_id":1,"summary":"x"}""")
        // Bad enum value -> schema invalid -> fed back.
        p.worker += call(Protocol.SUBMIT_RESULT, "w1b", result(1, "weird", "x"))
        // Valid.
        p.worker += call(Protocol.SUBMIT_RESULT, "w1c", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1b", """{"notes":"ok"}""")

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }

        assertTrue(r is OrchestrationResult.Completed)
        val workerReqs = p.requests.filter { p.levelOf(it).contains(Protocol.SUBMIT_RESULT) }
        assertEquals(3, workerReqs.size)
        // The invalid attempts were fed back as tool errors (as USER in the shim path).
        assertTrue(workerReqs[1].messages.any {
            it.role == Role.USER && it.content.contains("missing required argument 'status'")
        })
        assertTrue(workerReqs[2].messages.any {
            it.role == Role.USER && it.content.contains("not in enum")
        })
        assertEquals(listOf(WorkerResult(1, "done", "ok")), listener.results)
    }

    @Test
    fun `worker result with wrong task id is rejected and retried`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", result(99, "done", "wrong"))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1b", result(1, "done", "fixed"))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1b", """{"notes":"accepted"}""")

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(WorkerResult(1, "done", "fixed"), listener.results.single())
        val toolReplies = r.messages.filter { it.role == Role.TOOL }.map { it.content }
        assertTrue(toolReplies.any { it.contains("task_id 99 does not match dispatched task 1") })
    }

    @Test
    fun `worker that never fixes its result becomes a failed result`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", result(99))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1b", result(99))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1b", """{"notes":"accepted"}""")

        val listener = RecordingListener()
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 2)).run("go", listener)
        }

        assertTrue(r is OrchestrationResult.Completed)
        val failed = listener.results.single()
        assertEquals("failed", failed.status)
        assertTrue(failed.summary.startsWith("no result submitted"))
    }

    @Test
    fun `executor without submission triggers planner re-plan`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan(1))
        // A text-only executor turn completes the loop without any submission.
        p.executor += text("thinking")
        // Re-plan.
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan(1))
        val (e, w) = milestoneScript(5)
        p.executor += e; p.worker += w

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }

        assertTrue("result=$r", r is OrchestrationResult.Completed)
        assertEquals("replans=${listener.replans} result=$r", 1, listener.replans.size)
        assertTrue(listener.replans.single().contains("finished without submitting a structured result"))
        // The re-plan request carried the failure reason.
        val rePlanReq = p.requests[2]
        assertTrue(rePlanReq.messages.any { it.content.contains("could not be completed") })
    }

    @Test
    fun `worker turn limit becomes a failed result and executor re-dispatches`() {
        val p = ScriptedProvider()
        val limits = OrchestratorLimits(maxLevelModelTurns = 2)
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        // Worker only calls a (non-terminal) project tool: burns the turn budget without
        // ever submitting a result.
        p.worker += call("read_file", "w1a", """{"path":"a"}""")
        p.worker += call("read_file", "w1b", """{"path":"b"}""")
        // Executor dispatches a corrected task; the worker complies this time.
        p.executor += call(Protocol.SUBMIT_TASKS, "e1b", tasks(2))
        p.worker += call(Protocol.SUBMIT_RESULT, "w2a", result(2, "done", "fixed"))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1c", """{"notes":"verified"}""")

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p, limits).run("go", listener) }

        assertTrue("result=$r", r is OrchestrationResult.Completed)
        assertEquals(
            listOf(
                WorkerResult(1, "failed", "no result submitted: produced no structured result within the turn limit"),
                WorkerResult(2, "done", "fixed"),
            ),
            listener.results,
        )
        // A failed task is handled by executor re-dispatch, not a planner re-plan.
        assertEquals(0, listener.replans.size)
        assertEquals(listOf(listOf("1:1"), listOf("2:2")), listener.taskRounds)
    }

    @Test
    fun `planner without submission fails the run`() {
        val p = ScriptedProvider()
        // Plain text: not an "announcement", so the shim does not nudge/retry the turn.
        p.planner += text("thinking")
        val listener = RecordingListener()
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 1)).run("go", listener)
        }
        assertTrue(r is OrchestrationResult.Failed)
        assertTrue((r as OrchestrationResult.Failed).message.contains("Planner"))
    }

    @Test
    fun `plan with duplicate milestone ids is rejected and retried`() {
        val p = ScriptedProvider()
        p.planner += call(
            Protocol.SUBMIT_PLAN, "p1",
            """{"goal":"g","milestones":[{"id":1,"title":"a"},{"id":1,"title":"b"}]}""",
        )
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }
        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(1, listener.plan?.milestones?.size)
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content.contains("duplicate milestone id") })
    }

    @Test
    fun `plan that is never fixed fails with the planner turn limit`() {
        val p = ScriptedProvider()
        val bad = """{"goal":"g","milestones":[{"id":1,"title":"a"},{"id":1,"title":"b"}]}"""
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", bad)
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", bad)
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 2)).run("go", RecordingListener())
        }
        assertTrue(r is OrchestrationResult.Failed)
        assertTrue((r as OrchestrationResult.Failed).message.startsWith("Planner: "))
    }

    @Test
    fun `plan over the milestone limit is rejected and retried`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", plan(1, 2))
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", plan(1, 1))
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val listener = RecordingListener()
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxMilestones = 1)).run("go", listener)
        }
        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(1, listener.plan?.milestones?.size)
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content.contains("plan has 2 milestones (max 1)") })
    }

    @Test
    fun `task list over the round limit is rejected and retried`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1, 2))
        p.executor += call(Protocol.SUBMIT_TASKS, "e1b", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1c", """{"notes":"done"}""")
        val listener = RecordingListener()
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxTasksPerRound = 1)).run("go", listener)
        }
        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(listOf(listOf("1:1")), listener.taskRounds)
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content.contains("round has 2 tasks (max 1)") })
    }

    @Test
    fun `worker request carries only its briefing and the results it depends on`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", plan(1, 2))
        // Milestone 1: two tasks; worker 2 depends on task 1 only if told so.
        p.executor += call(
            Protocol.SUBMIT_TASKS, "e1a",
            """{"tasks":[{"id":1,"description":"t1","files":["a.kt"]},{"id":2,"description":"t2"},""" +
                """{"id":3,"description":"t3","files":["b.kt","c.kt"],"depends_on":[1]}]}""",
        )
        p.worker += call(Protocol.SUBMIT_RESULT, "w1", result(1, summary = "SUMMARY-ONE"))
        p.worker += call(Protocol.SUBMIT_RESULT, "w2", result(2, summary = "SUMMARY-TWO"))
        p.worker += call(Protocol.SUBMIT_RESULT, "w3", result(3, summary = "SUMMARY-THREE"))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1b", """{"notes":"EXEC-NOTES"}""")
        // Milestone 2 reuses task id 1, which must not see milestone 1 results.
        p.executor += call(Protocol.SUBMIT_TASKS, "e2a", """{"tasks":[{"id":1,"description":"m2t1","depends_on":[]}]}""")
        p.worker += call(Protocol.SUBMIT_RESULT, "w4", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2b", """{"notes":"ok"}""")

        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }

        assertTrue(r is OrchestrationResult.Completed)
        val workerReqs = p.requests.filter { levelOfWorker(it) }
        assertEquals(4, workerReqs.size)
        fun userText(req: ChatRequest) = req.messages.filter { it.role != Role.SYSTEM }.joinToString("\n") { it.content }
        assertEquals(
            "Goal: ship it\nMilestone 1: m1\nTask 1: t1\nFiles: a.kt",
            workerReqs[0].messages.last { it.role == Role.USER }.content,
        )
        val w2 = userText(workerReqs[1])
        assertTrue(!w2.contains("Prior") && !w2.contains("SUMMARY"))
        val w3 = workerReqs[2].messages.last { it.role == Role.USER }.content
        assertEquals(
            "Goal: ship it\nMilestone 1: m1\nTask 3: t3\nFiles: b.kt, c.kt\nPrior #1 done: SUMMARY-ONE",
            w3,
        )
        for (req in workerReqs) {
            val all = userText(req)
            assertTrue(!all.contains("EXEC-NOTES") && !all.contains("Break this milestone"))
        }
        val w4 = userText(workerReqs[3])
        assertTrue(!w4.contains("SUMMARY") && !w4.contains("Milestone 1"))
    }

    private fun levelOfWorker(req: ChatRequest) =
        req.messages.firstOrNull { it.role == Role.SYSTEM }?.content.orEmpty().contains(Protocol.SUBMIT_RESULT)

    @Test
    fun `workers are dispatched serially`() {
        val p = ScriptedProvider()
        val order = mutableListOf<String>()
        p.workerHook = { request, base ->
            // The hook fires for every level's requests; only trace Worker levels.
            val sys = request.messages.firstOrNull { it.role == Role.SYSTEM }?.content.orEmpty()
            if (sys.contains(Protocol.SUBMIT_RESULT)) {
                val content = request.messages.last { it.role == Role.USER }.content
                val n = if (content.contains("Task 1")) "1" else "2"
                order += "start$n"
                flow {
                    base.collect { emit(it) }
                    order += "end$n"
                }
            } else {
                base
            }
        }
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1, 2))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", result(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w2a", result(2))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e1b", """{"notes":"ok"}""")

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(listOf("start1", "end1", "start2", "end2"), order)
    }

    @Test
    fun `each level gets its role prompt and the run uses one model`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w

        val listener = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", listener) }
        assertTrue(r is OrchestrationResult.Completed)

        fun sysOf(req: ChatRequest) = req.messages.first { it.role == Role.SYSTEM }.content
        p.requests.forEach { req ->
            assertEquals("llama", req.model)
            val sys = sysOf(req)
            val expected = when {
                sys.contains(Protocol.SUBMIT_PLAN) ->
                    RolePrompts.forRole(AgentRole.PLANNER) + " " + Protocol.PLANNER
                sys.contains(Protocol.SUBMIT_TASKS) ->
                    RolePrompts.forRole(AgentRole.EXECUTOR) + " " + Protocol.EXECUTOR
                else -> RolePrompts.forRole(AgentRole.WORKER) + " " + Protocol.WORKER
            }
            // The shim appends a tool block to the system prompt.
            assertTrue(sys.startsWith(expected))
        }
        // Workers see the project tools in the shim tool block; planner and executor do not.
        p.requests.filter { sysOf(it).contains(Protocol.SUBMIT_RESULT) }
            .forEach { assertTrue(sysOf(it).contains("read_file")) }
        p.requests.filter { sysOf(it).contains(Protocol.SUBMIT_PLAN) || sysOf(it).contains(Protocol.SUBMIT_TASKS) }
            .forEach { assertTrue(!sysOf(it).contains("read_file")) }
    }

    @Test
    fun `cancellation propagates out of the run`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        // Worker hangs forever (hook replaces the scripted flow).
        p.worker += call(Protocol.SUBMIT_RESULT, "w1a", result(1))
        p.workerHook = { _, _ ->
            flow { while (true) { delay(20); emit(ProviderEvent.TextDelta(".")) } }
        }
        val listener = RecordingListener()
        val job = scope.launch { newOrchestrator(p).run("go", listener) }
        val deadline = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < deadline && p.requests.size < 3) Thread.sleep(10)
        job.cancel()
        val finished = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < finished && !job.isCompleted) Thread.sleep(10)
        assertTrue(job.isCancelled)
    }

    // --- M8: cancellation and failure codes ---

    @Test
    fun `cancelled run returns the transcript so far and the partial level output`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val inWorker = java.util.concurrent.CountDownLatch(1)
        p.workerHook = { req, base ->
            if (p.levelOf(req).contains(Protocol.SUBMIT_RESULT)) {
                flow {
                    emit(ProviderEvent.TextDelta("w-part"))
                    inWorker.countDown()
                    kotlinx.coroutines.awaitCancellation()
                }
            } else base
        }
        val captured = java.util.concurrent.atomic.AtomicReference<com.aijb.assistant.tools.RunCancelledException?>()
        runBlocking {
            val job = launch(kotlinx.coroutines.Dispatchers.Default) {
                try {
                    newOrchestrator(p).run("do it", RecordingListener())
                } catch (ex: com.aijb.assistant.tools.RunCancelledException) {
                    captured.set(ex)
                    throw ex
                }
            }
            assertTrue(inWorker.await(10, java.util.concurrent.TimeUnit.SECONDS))
            job.cancel()
            job.join()
        }
        val ex = captured.get()!!
        val produced = ex.produced
        // Planner's submission survives, and so does the worker's partial text.
        assertTrue(produced.any { m -> m.toolCalls.any { it.name == Protocol.SUBMIT_PLAN } })
        assertEquals("w-part", produced.last().content)
        assertEquals(Role.ASSISTANT, produced.last().role)
        assertTrue(ex.base.isEmpty())
        // Planner and executor each cost 10/5 before the worker was cancelled.
        assertEquals(Usage(20, 10), ex.usage)
    }

    @Test
    fun `failed run keeps the provider error code`() {
        val p = ScriptedProvider()
        p.planner += listOf(ProviderEvent.Failed("denied", code = "auth"))
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertTrue(r is OrchestrationResult.Failed)
        assertEquals("auth", (r as OrchestrationResult.Failed).code)
    }

    @Test
    fun `failure not caused by a provider has no code`() {
        val p = ScriptedProvider()
        p.planner += text("no tool call here")
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertTrue(r is OrchestrationResult.Failed)
        assertNull((r as OrchestrationResult.Failed).code)
    }

    @Test
    fun `failed run still counts the usage of the level that failed`() {
        val p = ScriptedProvider()
        p.planner += text("no tool call here", Usage(10, 5))
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertEquals(Usage(10, 5), (r as OrchestrationResult.Failed).usage)
    }
}

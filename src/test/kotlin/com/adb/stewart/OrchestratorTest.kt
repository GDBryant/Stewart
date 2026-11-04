package com.adb.stewart

import org.junit.Assert.assertNull
import com.adb.stewart.agents.AgentRole
import com.adb.stewart.agents.LevelRoute
import com.adb.stewart.agents.OrchestrationResult
import com.adb.stewart.agents.Orchestrator
import com.adb.stewart.agents.OrchestratorLimits
import com.adb.stewart.agents.OrchestratorListener
import com.adb.stewart.agents.Plan
import com.adb.stewart.agents.Protocol
import com.adb.stewart.agents.RolePrompts
import com.adb.stewart.agents.RoleRouting
import com.adb.stewart.agents.UserPrompter
import com.adb.stewart.agents.WorkerResult
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.Usage
import com.adb.stewart.shim.ToolCallingProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.ToolRegistry
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
import org.junit.Assert.assertFalse
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
        val questions = mutableListOf<Pair<String, List<String>>>()
        var withdrawn = 0
        val recovering = mutableListOf<Triple<com.adb.stewart.agents.FaultKind, String, Int>>()
        var completed: Usage? = null
        var failed: String? = null

        override fun onDelta(text: String) { deltas.append(text) }
        override fun onLevelStarted(role: AgentRole, context: String) { levels += role to context }
        override fun onPlan(plan: Plan) { this.plan = plan }
        override fun onTasks(taskRound: Int, tasks: List<com.adb.stewart.agents.DispatchTask>) {
            taskRounds += tasks.map { "${taskRound}:${it.id}" }
        }
        override fun onResult(result: WorkerResult) { results += result }
        override fun onReplanning(reason: String) { replans += reason }
        override fun onQuestion(question: String, options: List<String>) { questions += question to options }
        override fun onQuestionWithdrawn() { withdrawn++ }
        override fun onRecovering(kind: com.adb.stewart.agents.FaultKind, detail: String, depth: Int) {
            recovering += Triple(kind, detail, depth)
        }
        override fun onCompleted(usage: Usage?) { completed = usage }
        override fun onFailed(message: String) { failed = message }
    }

    private class ScriptedProvider : ModelProvider {
        override val id = "fake"
        val requests = mutableListOf<ChatRequest>()
        val planner = ArrayDeque<List<ProviderEvent>>()
        val executor = ArrayDeque<List<ProviderEvent>>()
        val worker = ArrayDeque<List<ProviderEvent>>()
        val recovery = ArrayDeque<List<ProviderEvent>>()
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
                level.contains(com.adb.stewart.agents.SUBMIT_RECOVERY) -> recovery
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
        prompter: UserPrompter? = null,
        scratch: com.adb.stewart.agents.Scratch? = null,
        tools: List<Tool> = listOf(fakeReadTool()),
        approval: ApprovalGate = ApprovalGate { _, _ -> ApprovalDecision.Approved },
        clock: () -> java.time.LocalDateTime = { java.time.LocalDateTime.now() },
        random: kotlin.random.Random = kotlin.random.Random.Default,
        retentionDays: Int = 0,
        recoveryLog: (String) -> Unit = {},
    ) = Orchestrator(
        routes = RoleRouting.uniform(
            LevelRoute(
                ModelRef(provider.id, "llama"),
                ToolCallingProvider(provider, com.adb.stewart.provider.ToolPath.SHIM),
            )
        ),
        projectTools = { ToolRegistry(tools) },
        approval = approval,
        limits = limits,
        prompter = prompter,
        clock = clock,
        random = random,
        scratch = scratch,
        scratchRetentionDays = retentionDays,
        recoveryLog = recoveryLog,
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
                AgentRole.EXECUTOR to "milestone 'm1' (1), round 2",
                AgentRole.EXECUTOR to "milestone 'm2' (2), round 1",
                AgentRole.WORKER to "milestone 'm2' (2), task 2: t2",
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
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 2, maxRecoveriesPerRun = 0)).run("go", RecordingListener())
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

    private fun allText(req: ChatRequest) = req.messages.joinToString("\n") { it.content }

    private fun plannerReqs(p: ScriptedProvider) =
        p.requests.filter { levelOfPlanner(it) }

    private fun levelOfPlanner(req: ChatRequest) =
        req.messages.firstOrNull { it.role == Role.SYSTEM }?.content.orEmpty().contains(Protocol.SUBMIT_PLAN)

    @Test
    fun `planner question reaches the prompter and the answer reaches the model`() {
        val p = ScriptedProvider()
        val asked = mutableListOf<Pair<String, List<String>>>()
        val events = mutableListOf<Pair<String, List<String>>>()
        p.planner += call(Protocol.ASK_USER, "a1", """{"question":"Which db?","options":["pg","mysql"]}""")
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (exec, work) = milestoneScript(1)
        p.executor += exec
        p.worker += work
        val prompter = UserPrompter { q, o -> asked += q to o; "use pg" }
        val listener = object : OrchestratorListener by RecordingListener() {
            override fun onQuestion(question: String, options: List<String>) { events += question to options }
        }

        val r = runBlocking { newOrchestrator(p, prompter = prompter).run("go", listener) }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(listOf("Which db?" to listOf("pg", "mysql")), asked)
        assertEquals(asked, events)
        val second = plannerReqs(p)[1]
        assertTrue(allText(second).contains("use pg"))
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content == "use pg" })
        assertTrue(allText(plannerReqs(p)[0]).contains(Protocol.ASK_USER))
    }

    @Test
    fun `question limit is enforced across the run and the model sees a tool error`() {
        val p = ScriptedProvider()
        var n = 0
        repeat(4) { i ->
            p.planner += call(Protocol.ASK_USER, "a$i", """{"question":"q$i"}""")
        }
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (exec, work) = milestoneScript(1)
        p.executor += exec
        p.worker += work

        val r = runBlocking {
            newOrchestrator(p, prompter = { _, _ -> "a${n++}" }).run("go", RecordingListener())
        }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(3, n)
        val tools = r.messages.filter { it.role == Role.TOOL }.map { it.content }
        assertEquals(listOf("a0", "a1", "a2"), tools.take(3))
        assertTrue(tools[3].startsWith("Error: question limit reached (max 3)"))
    }

    @Test
    fun `question budget is shared with the re-plan level`() {
        val p = ScriptedProvider()
        var n = 0
        p.planner += call(Protocol.ASK_USER, "a0", """{"question":"first"}""")
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += text("no submission")
        p.planner += call(Protocol.ASK_USER, "a1", """{"question":"second"}""")
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        val (exec, work) = milestoneScript(1)
        p.executor += exec
        p.worker += work

        val limits = OrchestratorLimits(maxQuestions = 1, maxLevelModelTurns = 2)
        val r = runBlocking {
            newOrchestrator(p, limits, prompter = { _, _ -> "a${n++}" }).run("go", RecordingListener())
        }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(1, n)
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content.startsWith("Error: question limit reached (max 1)") })
    }

    @Test
    fun `invalid ask_user arguments are tool errors and do not count`() {
        val p = ScriptedProvider()
        var n = 0
        p.planner += call(Protocol.ASK_USER, "a0", """{"question":"  "}""")
        p.planner += call(Protocol.ASK_USER, "a1", """{"question":"q","options":[1]}""")
        p.planner += call(Protocol.ASK_USER, "a2", """{"question":"q","options":"pg"}""")
        p.planner += call(Protocol.ASK_USER, "a3", """{"question":"real","options":[" a ",""]}""")
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (exec, work) = milestoneScript(1)
        p.executor += exec
        p.worker += work
        val seen = mutableListOf<List<String>>()

        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxQuestions = 1), prompter = { _, o -> seen += o; "ok${n++}" })
                .run("go", RecordingListener())
        }

        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(listOf(listOf("a")), seen)
        val tools = r.messages.filter { it.role == Role.TOOL }.map { it.content }
        assertTrue(tools[0].startsWith("Error:") && tools[1].startsWith("Error:") && tools[2].startsWith("Invalid"))
        assertEquals("ok0", tools[3])
    }

    @Test
    fun `ask_user is offered to the planner only and only with a prompter`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (exec, work) = milestoneScript(1)
        p.executor += exec
        p.worker += work
        runBlocking { newOrchestrator(p, prompter = { _, _ -> "x" }).run("go", RecordingListener()) }
        for (req in p.requests) {
            val sys = req.messages.first { it.role == Role.SYSTEM }.content
            assertEquals(sys, levelOfPlanner(req), sys.contains(Protocol.ASK_USER))
        }

        val q = ScriptedProvider()
        q.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (exec2, work2) = milestoneScript(1)
        q.executor += exec2
        q.worker += work2
        runBlocking { newOrchestrator(q).run("go", RecordingListener()) }
        assertTrue(q.requests.none { allText(it).contains(Protocol.ASK_USER) })
    }

    @Test
    fun `cancelling while the question is open keeps the transcript and marks it not answered`() {
        val p2 = ScriptedProvider()
        p2.planner += call(Protocol.ASK_USER, "a1", """{"question":"Which db?"}""")
        val e = runBlocking {
            val waiting2 = kotlinx.coroutines.CompletableDeferred<Unit>()
            val deferred = kotlinx.coroutines.CompletableDeferred<com.adb.stewart.tools.RunCancelledException>()
            val job = scope.launch {
                try {
                    newOrchestrator(
                        p2,
                        prompter = { _, _ -> waiting2.complete(Unit); kotlinx.coroutines.awaitCancellation() },
                    ).run("go", RecordingListener())
                } catch (ex: com.adb.stewart.tools.RunCancelledException) {
                    deferred.complete(ex)
                }
            }
            waiting2.await()
            job.cancel()
            deferred.await()
        }
        val tool = e.produced.last { it.role == Role.TOOL }
        assertEquals("Not answered: cancelled", tool.content)
        assertEquals(0, e.uncertainOutcomes)
        assertTrue(e.produced.any { it.role == Role.ASSISTANT && it.toolCalls.isNotEmpty() })
    }

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
        val captured = java.util.concurrent.atomic.AtomicReference<com.adb.stewart.tools.RunCancelledException?>()
        runBlocking {
            val job = launch(kotlinx.coroutines.Dispatchers.Default) {
                try {
                    newOrchestrator(p).run("do it", RecordingListener())
                } catch (ex: com.adb.stewart.tools.RunCancelledException) {
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

    private fun failedPlanner(code: String?) =
        listOf<ProviderEvent>(ProviderEvent.Failed("boom", code = code))

    @Test
    fun `provider failure code propagates to level status and result`() {
        for (code in listOf("truncated", "incomplete_stream", "protocol_error", "rate_limit")) {
            val p = ScriptedProvider()
            p.planner += failedPlanner(code)
            p.planner += failedPlanner(code) // retried once for truncated / incomplete_stream
            val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
            assertEquals(code, (r as OrchestrationResult.Failed).code)
        }
    }

    @Test
    fun `non tool loop failure has null code`() {
        val p = ScriptedProvider()
        p.planner += text("no tool call here")
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertNull((r as OrchestrationResult.Failed).code)

        val q = ScriptedProvider()
        q.planner += failedPlanner(null)
        val r2 = runBlocking { newOrchestrator(q).run("go", RecordingListener()) }
        assertNull((r2 as OrchestrationResult.Failed).code)
    }

    @Test
    fun `executor failure code survives replan budget exhaustion`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        p.executor += failedPlanner("truncated")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 0)).run("go", RecordingListener())
        }
        assertEquals("truncated", (r as OrchestrationResult.Failed).code)
    }

    @Test
    fun `round limit failure after an earlier truncated failure reports no stale code`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        p.executor += failedPlanner("truncated")
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1", result(1))
        p.executor += call(Protocol.SUBMIT_TASKS, "e2", tasks(2))
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 2, maxTaskRounds = 1)).run("go", RecordingListener())
        }
        r as OrchestrationResult.Failed
        assertTrue(r.message, r.message.contains("not met after 1 task rounds"))
        assertNull(r.code)
    }

    private fun taskArgs(extra: String) =
        """{"tasks":[{"id":1,"description":"t1"$extra}]}"""

    /** Runs one milestone whose worker makes [readCalls] read_file calls before submitting; returns worker results. */
    private fun workerRun(
        readCalls: Int,
        limits: OrchestratorLimits,
        taskExtra: String = "",
        milestoneExtra: String = "",
    ): List<WorkerResult> {
        val p = ScriptedProvider()
        p.planner += call(
            Protocol.SUBMIT_PLAN, "p1",
            """{"goal":"g","milestones":[{"id":1,"title":"m1","notes":"n"$milestoneExtra}]}"""
        )
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", taskArgs(taskExtra))
        repeat(readCalls) { p.worker += call("read_file", "w$it", """{"path":"a"}""") }
        p.worker += call(Protocol.SUBMIT_RESULT, "ws", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        runBlocking { newOrchestrator(p, limits).run("go", l) }
        return l.results
    }

    private val smallDefault = OrchestratorLimits(maxLevelModelTurns = 3)

    @Test
    fun `worker without a budget uses the level default and hits the turn limit`() {
        val r = workerRun(4, smallDefault)
        assertEquals("failed", r.single().status)
    }

    @Test
    fun `task max_turns raises the worker limit`() {
        assertEquals("done", workerRun(4, smallDefault, taskExtra = ""","max_turns":6""").single().status)
    }

    @Test
    fun `milestone turn_budget raises the worker limit`() {
        assertEquals("done", workerRun(4, smallDefault, milestoneExtra = ""","turn_budget":6""").single().status)
    }

    @Test
    fun `task max_turns overrides the milestone budget`() {
        val r = workerRun(4, smallDefault, taskExtra = ""","max_turns":2""", milestoneExtra = ""","turn_budget":9""")
        assertEquals("failed", r.single().status)
    }

    @Test
    fun `ceiling clamps the default worker limit`() {
        assertEquals("done", workerRun(2, smallDefault).single().status)
        val r = workerRun(2, OrchestratorLimits(maxLevelModelTurns = 3, maxWorkerTurnsCeiling = 2))
        assertEquals("failed", r.single().status)
    }

    @Test
    fun `out of range max_turns is a tool error and the executor can resubmit`() {
        for (bad in listOf(0, 51)) {
            val p = ScriptedProvider()
            p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
            p.executor += call(Protocol.SUBMIT_TASKS, "e1a", taskArgs(""","max_turns":$bad"""))
            p.executor += call(Protocol.SUBMIT_TASKS, "e1b", taskArgs(""","max_turns":50"""))
            p.worker += call(Protocol.SUBMIT_RESULT, "w1", result(1))
            p.executor += call(Protocol.COMPLETE_MILESTONE, "e1c", """{"notes":"done"}""")
            val l = RecordingListener()
            val r = runBlocking {
                newOrchestrator(p, OrchestratorLimits(maxWorkerTurnsCeiling = 50)).run("go", l)
            }
            assertTrue(r is OrchestrationResult.Completed)
            assertEquals(listOf(listOf("1:1")), l.taskRounds)
            assertTrue(r.messages.any { it.role == Role.TOOL && it.content.contains("max_turns must be between 1 and 50") })
        }
    }

    @Test
    fun `out of range turn_budget is a tool error in the plan`() {
        val p = ScriptedProvider()
        val bad = """{"goal":"g","milestones":[{"id":1,"title":"m1","turn_budget":0}]}"""
        p.planner += call(Protocol.SUBMIT_PLAN, "p1a", bad)
        p.planner += call(Protocol.SUBMIT_PLAN, "p1b", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertTrue(r is OrchestrationResult.Completed)
        assertTrue(r.messages.any { it.role == Role.TOOL && it.content.contains("turn_budget must be between 1") })
    }

    // --- layer-0 recovery ---------------------------------------------------------

    private fun requestsFor(p: ScriptedProvider, marker: String) =
        p.requests.filter { it.messages.firstOrNull { m -> m.role == Role.SYSTEM }?.content.orEmpty().contains(marker) }

    private fun lastUser(req: ChatRequest) = req.messages.last { it.role == Role.USER }.content

    @Test
    fun `incomplete_stream at the planner is retried once with the same input`() {
        val p = ScriptedProvider()
        p.planner += failedPlanner("incomplete_stream")
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val r = runBlocking { newOrchestrator(p).run("do it", RecordingListener()) }
        assertTrue(r is OrchestrationResult.Completed)
        val reqs = plannerReqs(p)
        assertEquals(2, reqs.size)
        assertEquals(lastUser(reqs[0]), lastUser(reqs[1]))
        assertTrue(!lastUser(reqs[1]).contains("output limit"))
    }

    @Test
    fun `incomplete_stream at the worker is retried once`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.worker += failedPlanner("incomplete_stream")
        p.worker += call(Protocol.SUBMIT_RESULT, "w1", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", l) }
        assertTrue(r is OrchestrationResult.Completed)
        assertEquals("done", l.results.single().status)
    }

    @Test
    fun `incomplete_stream failing twice falls through to the normal failure path`() {
        val p = ScriptedProvider()
        p.planner += failedPlanner("incomplete_stream")
        p.planner += failedPlanner("incomplete_stream")
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertEquals("incomplete_stream", (r as OrchestrationResult.Failed).code)
        assertEquals(2, plannerReqs(p).size)
    }

    @Test
    fun `executor truncated is retried with a fewer hint when the count is unknown`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val l = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", l) }
        assertTrue(r is OrchestrationResult.Completed)
        assertTrue(l.replans.isEmpty())
        val reqs = requestsFor(p, Protocol.SUBMIT_TASKS)
        assertTrue(!lastUser(reqs[0]).contains("output limit"))
        val hint = lastUser(reqs[1])
        assertTrue(hint, hint.contains("Your previous reply hit the output limit. Submit fewer tasks (or milestones)"))
        assertTrue(hint.contains("under 300 chars"))
    }

    @Test
    fun `executor turn limit retry uses half of the previous task count`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1, 2, 3, 4, 5))
        repeat(5) { p.worker += call(Protocol.SUBMIT_RESULT, "w$it", result(it + 1)) }
        // Round 2: the executor burns its turns on non-terminal calls, then the retry succeeds.
        repeat(2) { p.executor += call("read_file", "x$it", """{"path":"a"}""") }
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e3", """{"notes":"done"}""")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 2, maxTasksPerRound = 8)).run("go", RecordingListener())
        }
        assertTrue(r is OrchestrationResult.Completed)
        val hints = requestsFor(p, Protocol.SUBMIT_TASKS).map { lastUser(it) }.filter { it.contains("output limit") }
        assertTrue(hints.toString(), hints.isNotEmpty() && hints.all { it.contains("at most 3 tasks") })
    }

    @Test
    fun `planner truncated is retried with a hint`() {
        val p = ScriptedProvider()
        p.planner += failedPlanner("truncated")
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val r = runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
        assertTrue(r is OrchestrationResult.Completed)
        assertTrue(lastUser(plannerReqs(p)[1]).contains("Submit fewer tasks"))
    }

    @Test
    fun `size fault failing again falls through to replanning`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        p.executor += failedPlanner("truncated")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 0)).run("go", RecordingListener())
        }
        r as OrchestrationResult.Failed
        assertEquals("truncated", r.code)
        assertEquals(2, requestsFor(p, Protocol.SUBMIT_TASKS).size)
    }

    @Test
    fun `worker truncated is not retried here`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.worker += failedPlanner("truncated")
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        runBlocking { newOrchestrator(p).run("go", l) }
        assertEquals("failed", l.results.single().status)
        assertEquals(1, requestsFor(p, Protocol.SUBMIT_RESULT).size)
    }

    @Test
    fun `worker turn limit is not retried here`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        repeat(3) { p.worker += call("read_file", "w$it", """{"path":"a"}""") }
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        runBlocking { newOrchestrator(p, smallDefault).run("go", l) }
        assertEquals("failed", l.results.single().status)
        assertEquals(3, requestsFor(p, Protocol.SUBMIT_RESULT).size)
    }

    @Test
    fun `no retry once the recovery budget is exhausted`() {
        val p = ScriptedProvider()
        p.planner += failedPlanner("incomplete_stream")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxRecoveriesPerRun = 0)).run("go", RecordingListener())
        }
        assertEquals("incomplete_stream", (r as OrchestrationResult.Failed).code)
        assertEquals(1, plannerReqs(p).size)
    }

    @Test
    fun `recovery budget is shared across levels and resets per run`() {
        val p = ScriptedProvider()
        p.planner += failedPlanner("incomplete_stream")
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("incomplete_stream") // budget of 1 already spent: no retry
        val o = newOrchestrator(p, OrchestratorLimits(maxRecoveriesPerRun = 1, maxReplans = 0))
        val r = runBlocking { o.run("go", RecordingListener()) }
        assertEquals("incomplete_stream", (r as OrchestrationResult.Failed).code)
        assertEquals(1, requestsFor(p, Protocol.SUBMIT_TASKS).size)
        // A second run gets a fresh budget.
        p.planner += failedPlanner("incomplete_stream")
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        p.executor += failedPlanner("incomplete_stream")
        runBlocking { o.run("again", RecordingListener()) }
        assertEquals(4, plannerReqs(p).size)
    }

    @Test
    fun `non recoverable codes are not retried`() {
        for (code in listOf("rate_limit", "protocol_error", "context_limit", null)) {
            val p = ScriptedProvider()
            p.planner += failedPlanner(code)
            runBlocking { newOrchestrator(p).run("go", RecordingListener()) }
            assertEquals(code, 1, plannerReqs(p).size)
        }
    }

    @Test
    fun `workerTurns resolves task then milestone then default then ceiling`() {
        val p = ScriptedProvider()
        val o = newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 15, maxWorkerTurnsCeiling = 40))
        val m = com.adb.stewart.agents.Milestone(1, "m", "n")
        val mb = m.copy(turnBudget = 25)
        fun t(max: Int?) = com.adb.stewart.agents.DispatchTask(1, "d", maxTurns = max)
        assertEquals(15, o.workerTurns(t(null), m))
        assertEquals(25, o.workerTurns(t(null), mb))
        assertEquals(30, o.workerTurns(t(30), mb))
        assertEquals(40, o.workerTurns(t(100), mb))
        assertEquals(40, o.workerTurns(t(null), m.copy(turnBudget = 99)))
    }

    @Test
    fun `executor and planner turns stay at the level default`() {
        // Executor makes 3 non-terminal calls (> maxLevelModelTurns=2); a high ceiling must not extend it.
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        repeat(3) { p.executor += call("read_file", "x$it", """{"path":"a"}""") }
        val r = runBlocking {
            newOrchestrator(
                p, OrchestratorLimits(maxLevelModelTurns = 2, maxWorkerTurnsCeiling = 200, maxReplans = 0, maxRecoveriesPerRun = 0)
            ).run("go", RecordingListener())
        }
        assertTrue(r is OrchestrationResult.Failed)
        assertEquals(2, p.requests.count { it.messages.firstOrNull { m -> m.role == Role.SYSTEM }?.content.orEmpty().contains(Protocol.SUBMIT_TASKS) })
    }

    private fun orchestratorWith(
        p: ScriptedProvider,
        clock: () -> java.time.LocalDateTime,
        random: kotlin.random.Random,
    ) = Orchestrator(
        routes = RoleRouting.uniform(
            LevelRoute(ModelRef(p.id, "llama"), ToolCallingProvider(p, com.adb.stewart.provider.ToolPath.SHIM))
        ),
        projectTools = { ToolRegistry(emptyList()) },
        approval = ApprovalGate { _, _ -> ApprovalDecision.Approved },
        clock = clock,
        random = random,
    )

    @Test
    fun `run id has timestamp and 4 hex and is unique per run`() {
        val p = ScriptedProvider()
        p.planner += text("x"); p.planner += text("y")
        val times = ArrayDeque(listOf(
            java.time.LocalDateTime.of(2026, 11, 4, 9, 5, 7),
            java.time.LocalDateTime.of(2026, 11, 4, 9, 5, 8),
        ))
        val o = orchestratorWith(p, { times.removeFirst() }, kotlin.random.Random(42))
        assertEquals("", o.runId)
        runBlocking { o.run("a", RecordingListener()) }
        val first = o.runId
        runBlocking { o.run("b", RecordingListener()) }
        val second = o.runId
        val re = Regex("""\d{8}-\d{6}-[0-9a-f]{4}""")
        assertTrue(first, re.matches(first))
        assertTrue(second, re.matches(second))
        assertTrue(first.startsWith("20261104-090507-"))
        assertTrue(second.startsWith("20261104-090508-"))
        assertTrue(first != second)
    }

    @Test
    fun `run id is deterministic with same clock and seed`() {
        val t = java.time.LocalDateTime.of(2026, 1, 2, 3, 4, 5)
        val ids = (1..2).map {
            val p = ScriptedProvider(); p.planner += text("x")
            val o = orchestratorWith(p, { t }, kotlin.random.Random(7))
            runBlocking { o.run("a", RecordingListener()) }
            o.runId
        }
        assertEquals(ids[0], ids[1])
    }

    // --- worker turn-limit continue question -------------------------------------------------

    private class ScriptedPrompter(val answer: suspend (String, List<String>) -> String) : UserPrompter {
        val asked = mutableListOf<Pair<String, List<String>>>()
        override suspend fun ask(question: String, options: List<String>): String {
            asked += question to options
            return answer(question, options)
        }
    }

    private val turn3 = OrchestratorLimits(maxLevelModelTurns = 3)

    /** One task whose worker reads [paths] then submits; returns provider, listener and results. */
    private fun continueRun(
        paths: List<String>,
        limits: OrchestratorLimits = turn3,
        prompter: UserPrompter?,
    ): Pair<ScriptedProvider, RecordingListener> {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        paths.forEachIndexed { i, path -> p.worker += call("read_file", "w$i", """{"path":"$path"}""") }
        p.worker += call(Protocol.SUBMIT_RESULT, "ws", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        runBlocking { newOrchestrator(p, limits, prompter).run("go", l) }
        return p to l
    }

    private val distinct = listOf("a", "b", "c", "d")

    @Test
    fun `continue answer resumes the worker and it completes`() {
        val pr = ScriptedPrompter { _, o -> o.first() }
        val (p, l) = continueRun(distinct, prompter = pr)
        assertEquals("done", l.results.single().status)
        assertEquals(1, pr.asked.size)
        assertTrue(pr.asked[0].second.first().startsWith("Continue"))
        assertEquals(pr.asked[0], l.questions.single())
        // The resumed run kept its history: the last worker request still has the earlier reads.
        val last = requestsFor(p, Protocol.SUBMIT_RESULT).last()
        assertTrue(last.messages.count { it.content.contains("FILE CONTENT") } >= 4)
    }

    @Test
    fun `free text answer reaches the worker and resumes`() {
        val pr = ScriptedPrompter { _, _ -> "look at file z instead" }
        val (p, l) = continueRun(distinct, prompter = pr)
        assertEquals("done", l.results.single().status)
        val last = requestsFor(p, Protocol.SUBMIT_RESULT).last()
        assertTrue(last.messages.any { it.content.contains("look at file z instead") })
    }

    @Test
    fun `stop answer gives the existing turn-limit failure`() {
        val pr = ScriptedPrompter { _, o -> o.last() }
        val (p, l) = continueRun(listOf("a", "b", "c"), prompter = pr)
        val r = l.results.single()
        assertEquals("failed", r.status)
        assertEquals("stopped by user at turn limit", r.summary)
        assertEquals(3, requestsFor(p, Protocol.SUBMIT_RESULT).size)
        assertEquals(1, pr.asked.size)
    }

    @Test
    fun `blank answer stops`() {
        val pr = ScriptedPrompter { _, _ -> "  " }
        val (_, l) = continueRun(listOf("a", "b", "c"), prompter = pr)
        assertEquals("failed", l.results.single().status)
        assertEquals("stopped by user at turn limit", l.results.single().summary)
    }

    @Test
    fun `split answer without scratch space falls through to the failure`() {
        val pr = ScriptedPrompter { _, o -> o.firstOrNull { it.startsWith("Split") } ?: o.last() }
        val (p, l) = continueRun(listOf("a", "b", "c"), prompter = pr)
        assertTrue(pr.asked.single().second.none { it.startsWith("Split") }) // not offered without scratch
        assertEquals("failed", l.results.single().status)
        assertTrue(requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).isEmpty())
    }

    @Test
    fun `continue answer does not trigger a split`() {
        val pr = ScriptedPrompter { _, o -> o.first() }
        val (p, l) = continueRun(distinct, prompter = pr)
        assertTrue(requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).isEmpty())
        assertEquals("done", l.results.single().status)
    }

    @Test
    fun `timeout withdraws the question and falls through to split`() {
        val pr = ScriptedPrompter { _, _ -> delay(60_000); "never" }
        val limits = turn3.copy(continueQuestionTimeout = 50.milliseconds)
        val (_, l) = continueRun(listOf("a", "b", "c"), limits, pr)
        assertEquals(1, l.withdrawn)
        assertEquals("failed", l.results.single().status)
    }

    @Test
    fun `answer before the timeout is not withdrawn`() {
        val pr = ScriptedPrompter { _, o -> o.first() }
        val limits = turn3.copy(continueQuestionTimeout = 5_000.milliseconds)
        val (_, l) = continueRun(distinct, limits, pr)
        assertEquals(0, l.withdrawn)
        assertEquals("done", l.results.single().status)
    }

    /** Without a question the worker goes straight to the split when scratch is set; otherwise it fails as before. */
    private fun assertNotAsked(limits: OrchestratorLimits, withPrompter: Boolean = true) {
        val pr = ScriptedPrompter { _, o -> o.first() }
        // Negative: no scratch space, so no split is possible and the plain turn-limit failure stands.
        val (p0, l0) = continueRun(listOf("a", "b", "c"), limits, if (withPrompter) pr else null)
        assertTrue(pr.asked.isEmpty())
        assertTrue(l0.questions.isEmpty())
        assertEquals("failed", l0.results.single().status)
        assertTrue(requestsFor(p0, com.adb.stewart.agents.SUBMIT_RECOVERY).isEmpty())
        // Positive: with scratch space the gate failure splits.
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val (l, _) = runSplit(p, limits, prompter = if (withPrompter) pr else null)
        assertTrue(pr.asked.isEmpty())
        assertTrue(l.questions.isEmpty())
        assertEquals("done", l.results.single().status)
        assertEquals(1, requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).size)
    }

    @Test
    fun `no prompter means no question`() = assertNotAsked(turn3, withPrompter = false)

    @Test
    fun `askOnTurnLimit off means no question`() = assertNotAsked(turn3.copy(askOnTurnLimit = false))

    @Test
    fun `continuations cap prevents the question`() = assertNotAsked(turn3.copy(maxContinuations = 0))

    @Test
    fun `per-task continuation cap stops the second question`() {
        val pr = ScriptedPrompter { _, o -> o.first() }
        val paths = listOf("a", "b", "c", "d", "e", "f")
        val (_, l) = continueRun(paths, turn3.copy(maxContinuations = 1), pr)
        assertEquals(1, pr.asked.size)
        assertEquals("failed", l.results.single().status)
    }

    @Test
    fun `per-run question cap prevents the question and is separate from maxQuestions`() {
        val pr = ScriptedPrompter { _, o -> o.first() }
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1, 2))
        listOf("a", "b", "c", "d").forEachIndexed { i, x -> p.worker += call("read_file", "w$i", """{"path":"$x"}""") }
        p.worker += call(Protocol.SUBMIT_RESULT, "ws1", result(1))
        listOf("a", "b", "c").forEachIndexed { i, x -> p.worker += call("read_file", "v$i", """{"path":"$x"}""") }
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        runBlocking {
            newOrchestrator(p, turn3.copy(maxContinueQuestionsPerRun = 1, maxQuestions = 0), pr).run("go", l)
        }
        assertEquals(1, pr.asked.size)
        assertEquals(listOf("done", "failed"), l.results.map { it.status })
    }

    @Test
    fun `split is offered only when scratch depth and budget allow it`() {
        val pr = ScriptedPrompter { _, o -> o.last() }
        continueRun(listOf("a", "b", "c"), prompter = pr) // no scratch
        assertTrue(pr.asked.single().second.none { it.startsWith("Split") })
        assertEquals(2, pr.asked.single().second.size)
        for (lim in listOf(
            turn3.copy(maxRecoveryDepth = 0),
            turn3.copy(maxRecoveriesPerRun = 0),
        )) {
            val pr2 = ScriptedPrompter { _, o -> o.last() }
            val p = splitProvider()
            reads(p, 3, "w")
            runSplit(p, lim, prompter = pr2)
            assertTrue(lim.toString(), pr2.asked.single().second.none { it.startsWith("Split") })
        }
        val pr3 = ScriptedPrompter { _, o -> o.last() }
        val p = splitProvider()
        reads(p, 3, "w")
        runSplit(p, prompter = pr3)
        assertTrue(pr3.asked.single().second.any { it.startsWith("Split") })
    }

    @Test
    fun `stop in a split-capable run reports stopped by user and does not split`() {
        val pr = ScriptedPrompter { _, o -> o.last() }
        val p = splitProvider()
        reads(p, 3, "w")
        val (l, _) = runSplit(p, prompter = pr)
        assertEquals("stopped by user at turn limit", l.results.single().summary)
        assertTrue(requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).isEmpty())
    }

    @Test
    fun `worker provider error code reaches the run failure`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.worker += failedPlanner("auth")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 0, maxTaskRounds = 1)).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertEquals("auth", r.code)
    }

    @Test
    fun `worker failure without a code leaves the run failure code null`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.worker += failedPlanner(null)
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 0, maxTaskRounds = 1)).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertEquals(null, r.code)
    }

    @Test
    fun `completed run deletes the whole run scratch dir including obsolete kept dirs`() {
        val stale = splitScratch.runDir(rid).resolve("task-9-9")
        java.nio.file.Files.createDirectories(stale)
        java.nio.file.Files.writeString(stale.resolve("old.txt"), "x")
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val (_, r) = runSplit(p)
        assertTrue(r is OrchestrationResult.Completed)
        assertFalse(java.nio.file.Files.exists(splitScratch.runDir(rid)))
    }

    @Test
    fun `failed run keeps its scratch dir`() {
        val stale = splitScratch.runDir(rid).resolve("task-9-9")
        java.nio.file.Files.createDirectories(stale)
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1, "failed", "no"))
        val r = runBlocking {
            newOrchestrator(
                p, OrchestratorLimits(maxLevelModelTurns = 3, maxReplans = 0, maxTaskRounds = 1), splitAnswer, splitScratch,
                listOf(fakeReadTool(), fakeWriteTool()), RecordingGate(), fixedClock, fixedRandom(),
            ).run("go", RecordingListener())
        }
        assertTrue(r is OrchestrationResult.Failed)
        assertTrue(java.nio.file.Files.isDirectory(stale))
    }

    private fun replanFailRun(withScratch: Boolean): OrchestrationResult.Failed {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1, "failed", "no"))
        p.planner += failedPlanner("protocol_error")
        return runBlocking {
            newOrchestrator(
                p, OrchestratorLimits(maxLevelModelTurns = 3, maxReplans = 2, maxTaskRounds = 1), splitAnswer,
                if (withScratch) splitScratch else null,
                listOf(fakeReadTool(), fakeWriteTool()), RecordingGate(), fixedClock, fixedRandom(),
            ).run("go", RecordingListener())
        } as OrchestrationResult.Failed
    }

    @Test
    fun `re-plan failed message names the kept scratch dir`() {
        val r = replanFailRun(true)
        assertTrue(r.message, r.message.startsWith("re-plan failed:"))
        assertTrue(r.message, r.message.contains("; scratch: " + splitScratch.runDir(rid)))
    }

    @Test
    fun `re-plan failed message has no scratch part without scratch space`() {
        val r = replanFailRun(false)
        assertTrue(r.message, r.message.startsWith("re-plan failed:"))
        assertFalse(r.message, r.message.contains("scratch:"))
    }

    @Test
    fun `cancel during a sub-task keeps the dir but unregisters it`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA")
        var n = 0
        p.workerHook = { _, base -> if (++n == 7) throw CancellationException("stop") else base }
        val ex = try {
            runSplit(p); null
        } catch (e: com.adb.stewart.tools.RunCancelledException) { e }
        assertTrue("no cancel", ex != null)
        assertTrue("dir", java.nio.file.Files.isDirectory(taskDir))
        assertFalse("registered", splitScratch.isInRegisteredTask(taskDir.resolve("x"), rid))
    }

    @Test
    fun `finished split unregisters its dir and a completed split stays registered while running`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val gate = RecordingGate()
        runSplit(p, gate = gate)
        assertTrue(gate.paths.isEmpty()) // the sub-task write was auto-approved while registered
        assertFalse(splitScratch.isInRegisteredTask(taskDir.resolve("x"), rid))
    }

    @Test
    fun `plain cancellation during the continue question keeps the worker messages`() {
        val pr = ScriptedPrompter { _, _ -> throw CancellationException("gone") }
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        listOf("a", "b", "c").forEachIndexed { i, x -> p.worker += call("read_file", "w$i", """{"path":"$x"}""") }
        val ex = try {
            runBlocking { newOrchestrator(p, turn3, pr).run("go", RecordingListener()) }; null
        } catch (e: com.adb.stewart.tools.RunCancelledException) { e }
        assertTrue(ex != null)
        assertEquals(3, ex!!.produced.count { it.role == Role.TOOL && it.content.contains("FILE CONTENT") })
    }

    @Test
    fun `cancellation without an in-flight worker carries no worker messages`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.workerHook = null
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "ws", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val r = runBlocking { newOrchestrator(p, turn3, ScriptedPrompter { _, _ -> throw CancellationException("x") }).run("go", RecordingListener()) }
        assertTrue(r is OrchestrationResult.Completed) // no question was needed, nothing cancelled
    }

    @Test
    fun `fault of an earlier round is not blamed for a later failure`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        reads(p, 3, "w")
        p.executor += failedPlanner("protocol_error")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 3, maxReplans = 0, maxTaskRounds = 2)).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertFalse(r.message, r.message.contains("fault:"))
    }

    @Test
    fun `fault of the last round is still reported when rounds run out`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        reads(p, 3, "w")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 3, maxReplans = 0, maxTaskRounds = 1)).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertTrue(r.message, r.message.contains("fault: turn_limit"))
    }

    @Test
    fun `stuck worker gets split as the first option`() {
        val pr = ScriptedPrompter { _, o -> o.last() }
        val p = splitProvider()
        listOf("a", "a", "a").forEachIndexed { i, x -> p.worker += call("read_file", "w$i", """{"path":"$x"}""") }
        runSplit(p, prompter = pr)
        val opts = pr.asked.single().second
        assertTrue(opts.first().startsWith("Split"))
        assertTrue(pr.asked.single().first.contains("Looks stuck"))
    }

    @Test
    fun `executor incomplete_stream is retried once`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("incomplete_stream")
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val l = RecordingListener()
        val r = runBlocking { newOrchestrator(p).run("go", l) }
        assertTrue(r is OrchestrationResult.Completed)
        assertTrue(l.replans.isEmpty())
        val reqs = requestsFor(p, Protocol.SUBMIT_TASKS)
        assertEquals(lastUser(reqs[0]), lastUser(reqs[1]))
        assertTrue(!lastUser(reqs[1]).contains("output limit"))
    }

    @Test
    fun `planner turn limit is retried with a size hint`() {
        val p = ScriptedProvider()
        repeat(2) { p.planner += call("read_file", "x$it", """{"path":"a"}""") }
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (e, w) = milestoneScript(1, workerUsesTool = false)
        p.executor += e; p.worker += w
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 2)).run("go", RecordingListener())
        }
        assertTrue(r is OrchestrationResult.Completed)
        val reqs = plannerReqs(p)
        assertTrue(!lastUser(reqs[0]).contains("output limit"))
        assertTrue(lastUser(reqs.last()).contains("Your previous reply hit the output limit"))
    }

    @Test
    fun `re-plan call retries on incomplete_stream`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1a", tasks(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "w1", result(1, "failed", "boom"))
        p.executor += call(Protocol.SUBMIT_TASKS, "e1b", tasks(2))
        p.worker += call(Protocol.SUBMIT_RESULT, "w2", result(2, "failed", "boom"))
        p.planner += failedPlanner("incomplete_stream")
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        val (e, w) = milestoneScript(3, workerUsesTool = false)
        p.executor += e; p.worker += w
        val l = RecordingListener()
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxTaskRounds = 2, maxReplans = 2)).run("go", l)
        }
        assertTrue(r is OrchestrationResult.Completed)
        assertEquals(1, l.replans.size)
        assertEquals(3, plannerReqs(p).size)
        assertEquals(lastUser(plannerReqs(p)[1]), lastUser(plannerReqs(p)[2]))
    }

    // --- layer 1: worker split ----------------------------------------------------------------

    private val tmpRoot: java.nio.file.Path = java.nio.file.Files.createTempDirectory("stewart-split")
    private val fixedClock = { java.time.LocalDateTime.of(2026, 11, 4, 9, 5, 7) }
    private fun fixedRandom() = kotlin.random.Random(7)
    private val rid = "20261104-090507-" + "%04x".format(kotlin.random.Random(7).nextInt(0x10000))
    private val splitScratch by lazy { com.adb.stewart.agents.Scratch(tmpRoot) }
    private val taskDir by lazy { splitScratch.taskDir(rid, 1, 1) }

    @After
    fun cleanTmp() { tmpRoot.toFile().deleteRecursively() }

    /** WriteFile that really writes (project-relative paths resolve under [tmpRoot]). */
    private fun fakeWriteTool() = object : Tool {
        override val spec = ToolSpec("WriteFile", "w", JsonObject(emptyMap()))
        override val requiresApproval = true
        override suspend fun preview(arguments: JsonObject): ToolPreview {
            val path = tmpRoot.resolve(arguments["path"]!!.toString().trim('"')).toString()
            return ToolPreview.FileChange(path, null, arguments["content"]!!.toString().trim('"'))
        }
        override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
            val c = preview as ToolPreview.FileChange
            java.nio.file.Files.createDirectories(java.nio.file.Path.of(c.path).parent)
            java.nio.file.Files.writeString(java.nio.file.Path.of(c.path), c.after)
            return "wrote"
        }
    }

    private class RecordingGate(val reject: (String) -> Boolean = { false }) : ApprovalGate {
        val paths = mutableListOf<String>()
        override suspend fun review(call: com.adb.stewart.provider.ToolCall, preview: ToolPreview?): ApprovalDecision {
            val path = (preview as? ToolPreview.FileChange)?.path.orEmpty()
            paths += path
            return if (reject(path)) ApprovalDecision.Rejected("no") else ApprovalDecision.Approved
        }
    }

    // Split when offered; a nested question without a Split option (depth/budget spent) gets Stop.
    private val splitAnswer = ScriptedPrompter { _, o -> o.firstOrNull { it.startsWith("Split") } ?: o.last() }

    private fun recoveryCall(id: String, vararg files: String, finalFile: String? = null) = call(
        com.adb.stewart.agents.SUBMIT_RECOVERY, id,
        """{"subtasks":[${files.joinToString(",") { """{"description":"part $it","output_file":"$it"}""" }}]""" +
            (finalFile?.let { ""","final_file":"$it"""" } ?: "") + "}",
    )

    private fun writeCall(id: String, file: String, content: String, dir: java.nio.file.Path = taskDir) =
        call("WriteFile", id, """{"path":"${dir.resolve(file)}","content":"$content"}""")

    private fun reads(p: ScriptedProvider, n: Int, tag: String) =
        repeat(n) { p.worker += call("read_file", "$tag$it", """{"path":"f$it"}""") }

    private fun splitLimits(extra: OrchestratorLimits = OrchestratorLimits(maxLevelModelTurns = 3)) = extra

    /** Plan, one task whose worker burns its 3 turns; the caller scripts everything after. */
    private fun splitProvider(): ScriptedProvider {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        return p
    }

    private fun runSplit(
        p: ScriptedProvider,
        limits: OrchestratorLimits = splitLimits(),
        gate: ApprovalGate = RecordingGate(),
        prompter: UserPrompter? = splitAnswer,
    ): Pair<RecordingListener, OrchestrationResult> {
        val l = RecordingListener()
        val r = runBlocking {
            newOrchestrator(
                p, limits, prompter, splitScratch, listOf(fakeReadTool(), fakeWriteTool()), gate, fixedClock, fixedRandom(),
            ).run("go", l)
        }
        return l to r
    }

    @Test
    fun `split joins sub-task outputs into final_file through normal approval and cleans scratch`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt", finalFile = "out/All.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1, summary = "first"))
        p.worker += writeCall("s2", "p2.txt", "BBB"); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1, summary = "second"))
        val gate = RecordingGate()
        val (l, r) = runSplit(p, gate = gate)
        assertTrue(r.toString(), r is OrchestrationResult.Completed)
        val res = l.results.single()
        assertEquals("done", res.status)
        assertEquals(1, res.taskId)
        assertTrue(res.summary, res.summary.contains("final_file: out/All.txt") && res.summary.contains("first"))
        assertEquals("AAABBB", java.nio.file.Files.readString(tmpRoot.resolve("out/All.txt")))
        assertEquals(listOf(tmpRoot.resolve("out/All.txt").toString()), gate.paths) // scratch writes were auto-approved
        assertTrue(!java.nio.file.Files.exists(splitScratch.runDir(rid)))
        // Pre-split usage (3 reads) is kept: planner 1 + executor 2 + worker 3 + recovery 1 + 4 sub-task calls.
        assertEquals(Usage(110, 55), (r as OrchestrationResult.Completed).usage)
        val brief = lastUser(requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).single())
        assertTrue(brief, brief.contains("TURN_LIMIT") && brief.contains("read_file"))
        assertTrue(lastUser(requestsFor(p, Protocol.SUBMIT_RESULT)[5]).contains("Earlier sub-task 1"))
    }

    @Test
    fun `split without final_file keeps outputs unjoined and cleans scratch`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1))
        p.worker += writeCall("s2", "p2.txt", "BBB"); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val gate = RecordingGate()
        val (l, _) = runSplit(p, gate = gate)
        assertEquals("done", l.results.single().status)
        assertTrue(gate.paths.isEmpty())
        assertTrue(!java.nio.file.Files.exists(splitScratch.runDir(rid)))
    }

    @Test
    fun `timeout answer splits the task`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val pr = ScriptedPrompter { _, _ -> delay(60_000); "never" }
        val (l, _) = runSplit(p, splitLimits(OrchestratorLimits(maxLevelModelTurns = 3, continueQuestionTimeout = 50.milliseconds)), prompter = pr)
        assertEquals(1, l.withdrawn)
        assertEquals("done", l.results.single().status)
    }

    @Test
    fun `failing sub-task fails the task, keeps scratch and names its path`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt", finalFile = "out/All.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1, "failed", "could not"))
        val (l, _) = runSplit(p)
        val res = l.results.single()
        assertEquals("failed", res.status)
        assertTrue(res.summary, res.summary.contains("scratch kept: $taskDir"))
        // The run still completes (the executor accepts), so its scratch is removed at the end.
        assertFalse(java.nio.file.Files.exists(splitScratch.runDir(rid)))
        assertTrue(!java.nio.file.Files.exists(tmpRoot.resolve("out/All.txt")))
    }

    @Test
    fun `invalid submit_recovery after retries falls back to the plain failure`() {
        val p = splitProvider()
        reads(p, 3, "w")
        repeat(3) { p.recovery += call(com.adb.stewart.agents.SUBMIT_RECOVERY, "r$it", """{"subtasks":[{"description":"x","output_file":"../a"}]}""") }
        val (l, _) = runSplit(p)
        val res = l.results.single()
        assertEquals("failed", res.status)
        assertTrue(res.summary, res.summary.contains("recovery: no valid submit_recovery"))
        assertTrue(!java.nio.file.Files.exists(splitScratch.runDir(rid)))
    }

    @Test
    fun `invalid submit_recovery can be corrected within the level`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += call(com.adb.stewart.agents.SUBMIT_RECOVERY, "r0", """{"subtasks":[{"description":"x","output_file":"a"}]}""")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val (l, _) = runSplit(p)
        assertEquals("done", l.results.single().status)
    }

    private fun nestedProvider(): ScriptedProvider {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt", finalFile = "out/All.txt")
        reads(p, 3, "n")
        return p
    }

    @Test
    fun `a sub-task can be split again and its parts join into its output file`() {
        val p = nestedProvider()
        p.recovery += recoveryCall("r2", "x1.txt", "x2.txt")
        val sub = taskDir.resolve("split-0")
        p.worker += writeCall("a1", "x1.txt", "X1", sub); p.worker += call(Protocol.SUBMIT_RESULT, "a1r", result(1))
        p.worker += writeCall("a2", "x2.txt", "X2", sub); p.worker += call(Protocol.SUBMIT_RESULT, "a2r", result(1))
        p.worker += writeCall("s2", "p2.txt", "B"); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val gate = RecordingGate()
        val (l, _) = runSplit(p, gate = gate)
        assertEquals("done", l.results.single().status)
        assertEquals("X1X2B", java.nio.file.Files.readString(tmpRoot.resolve("out/All.txt")))
        assertEquals(listOf(tmpRoot.resolve("out/All.txt").toString()), gate.paths)
    }

    @Test
    fun `depth limit stops a nested split and fails the sub-task`() {
        val p = nestedProvider()
        val (l, _) = runSplit(p, splitLimits(OrchestratorLimits(maxLevelModelTurns = 3, maxRecoveryDepth = 1)))
        val res = l.results.single()
        assertEquals("failed", res.status)
        assertEquals("stopped by user at turn limit", res.summary.lines().first().substringAfter("[failed] ").substringBefore(" (file"))
        assertEquals(1, requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).size)
    }

    @Test
    fun `per-run budget counts splits and stops a nested split`() {
        val p = nestedProvider()
        val (l, _) = runSplit(p, splitLimits(OrchestratorLimits(maxLevelModelTurns = 3, maxRecoveriesPerRun = 1)))
        val res = l.results.single()
        assertEquals("failed", res.status)
        assertTrue(res.summary, res.summary.contains("stopped by user at turn limit"))
        assertEquals(1, requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).size)
    }

    @Test
    fun `worker truncated output is split`() {
        val p = splitProvider()
        p.worker += failedPlanner("truncated")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt", finalFile = "out/All.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1))
        p.worker += writeCall("s2", "p2.txt", "BBB"); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val (l, _) = runSplit(p, prompter = null)
        assertEquals("done", l.results.single().status)
        assertEquals("AAABBB", java.nio.file.Files.readString(tmpRoot.resolve("out/All.txt")))
        assertTrue(lastUser(requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).single()).contains("TRUNCATED"))
    }

    @Test
    fun `worker truncated output with no budget keeps the plain failure`() {
        val p = splitProvider()
        p.worker += failedPlanner("truncated")
        val (l, _) = runSplit(p, splitLimits(OrchestratorLimits(maxLevelModelTurns = 3, maxRecoveriesPerRun = 0)), prompter = null)
        val res = l.results.single()
        assertEquals("failed", res.status)
        assertTrue(res.summary, res.summary.contains("recovery budget exhausted"))
        assertTrue(requestsFor(p, com.adb.stewart.agents.SUBMIT_RECOVERY).isEmpty())
    }

    @Test
    fun `rejected final_file write fails recovery cleanly and keeps scratch`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt", finalFile = "out/All.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1))
        p.worker += writeCall("s2", "p2.txt", "BBB"); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val gate = RecordingGate(reject = { it.endsWith("All.txt") })
        val (l, _) = runSplit(p, gate = gate)
        val res = l.results.single()
        assertEquals("failed", res.status)
        assertTrue(res.summary, res.summary.contains("recovery: assembly failed: write to out/All.txt rejected"))
        assertTrue(res.summary, res.summary.contains("scratch: $taskDir"))
        assertTrue(!java.nio.file.Files.exists(tmpRoot.resolve("out/All.txt")))
        assertFalse(java.nio.file.Files.exists(splitScratch.runDir(rid))) // completed run: scratch removed
    }

    @Test
    fun `missing sub-task output fails assembly`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt", finalFile = "out/All.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val (l, _) = runSplit(p)
        assertTrue(l.results.single().summary, l.results.single().summary.contains("assembly failed: missing output for p1.txt"))
    }

    // --- review fixes -------------------------------------------------------------------------

    @Test
    fun `layer-0 retry does not reset the per-task continuation cap`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.worker += failedPlanner("incomplete_stream") // the continued run dies; layer 0 retries the worker
        reads(p, 3, "v")
        val pr = ScriptedPrompter { _, o -> o.first() }
        val l = RecordingListener()
        runBlocking { newOrchestrator(p, OrchestratorLimits(maxLevelModelTurns = 3, maxContinuations = 1), pr).run("go", l) }
        assertEquals(1, pr.asked.size)
        assertEquals("failed", l.results.single().status)
    }

    @Test
    fun `zero continue timeout waits for the answer`() {
        val pr = ScriptedPrompter { _, o -> delay(300); o.first() }
        val limits = turn3.copy(continueQuestionTimeout = kotlin.time.Duration.ZERO)
        val (_, l) = continueRun(distinct, limits, pr)
        assertEquals(0, l.withdrawn)
        assertEquals(1, pr.asked.size)
        assertEquals("done", l.results.single().status)
    }

    // --- layer 2, recovery status and logging, scratch prune -----------------------------------

    @Test
    fun `exhausted budget message carries fault and attempts, no scratch when none kept`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        p.executor += failedPlanner("truncated")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 0)).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertTrue(r.message, r.message.startsWith("re-planning budget exhausted: milestone"))
        assertTrue(r.message, r.message.contains("; fault: truncated ("))
        assertTrue(r.message, r.message.contains("; recovery: retried executor after truncated"))
        assertFalse(r.message, r.message.contains("scratch:"))
    }

    @Test
    fun `exhausted budget message without a fault stays plain`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("protocol_error")
        val r = runBlocking {
            newOrchestrator(p, OrchestratorLimits(maxReplans = 0)).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertFalse(r.message, r.message.contains("fault:"))
        assertFalse(r.message, r.message.contains("scratch:"))
    }

    @Test
    fun `exhausted budget message names the kept scratch dir`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += writeCall("s1", "p1.txt", "AAA"); p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1))
        p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1, "failed", "could not"))
        val r = runBlocking {
            newOrchestrator(
                p, OrchestratorLimits(maxLevelModelTurns = 3, maxReplans = 0, maxTaskRounds = 1), splitAnswer, splitScratch,
                listOf(fakeReadTool(), fakeWriteTool()), RecordingGate(), fixedClock, fixedRandom(),
            ).run("go", RecordingListener())
        } as OrchestrationResult.Failed
        assertTrue(r.message, r.message.contains("; fault: turn_limit"))
        assertTrue(r.message, r.message.contains("split task 1"))
        assertTrue(r.message, r.message.contains("; scratch: " + splitScratch.runDir(rid)))
    }

    @Test
    fun `replan input carries the fault note and size rule, first plan does not`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        p.executor += failedPlanner("truncated")
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        runBlocking { newOrchestrator(p, OrchestratorLimits(maxReplans = 2)).run("go", RecordingListener()) }
        val reqs = plannerReqs(p)
        assertEquals(2, reqs.size)
        val sys = { r: ChatRequest -> r.messages.first { it.role == Role.SYSTEM }.content }
        assertFalse(sys(reqs[0]).contains(Protocol.SIZE_RULE))
        assertFalse(lastUser(reqs[0]).contains("Fault:"))
        assertTrue(sys(reqs[1]).contains(Protocol.SIZE_RULE))
        assertTrue(sys(reqs[1]).contains("turn_budget"))
        val u = lastUser(reqs[1])
        assertTrue(u, u.contains("Fault: truncated ("))
        assertTrue(u, u.contains("Recovery attempted: retried executor after truncated"))
    }

    @Test
    fun `replan input has no fault line for a non-recoverable failure`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("protocol_error")
        p.planner += call(Protocol.SUBMIT_PLAN, "p2", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        runBlocking { newOrchestrator(p, OrchestratorLimits(maxReplans = 2)).run("go", RecordingListener()) }
        assertFalse(lastUser(plannerReqs(p)[1]).contains("Fault:"))
    }

    @Test
    fun `layer-0 retry reports recovering and logs with the run id`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("incomplete_stream")
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val l = RecordingListener()
        val log = mutableListOf<String>()
        val o = newOrchestrator(p, recoveryLog = { log += it })
        runBlocking { o.run("go", l) }
        assertEquals(
            listOf(Triple(com.adb.stewart.agents.FaultKind.INCOMPLETE_STREAM, "Stream dropped, retrying…", 0)), l.recovering,
        )
        assertTrue(log.toString(), log.isNotEmpty() && log.all { it.startsWith("[run ${o.runId}] ") })
        assertTrue(log.toString(), log.any { it.contains("layer 0") && it.contains("INCOMPLETE_STREAM") })
    }

    @Test
    fun `truncated executor retry says output limit`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += failedPlanner("truncated")
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val l = RecordingListener()
        runBlocking { newOrchestrator(p).run("go", l) }
        assertEquals("Output limit hit, retrying…", l.recovering.single().second)
    }

    @Test
    fun `clean run reports no recovering and logs nothing`() {
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        val (e, w) = milestoneScript(1)
        p.executor += e; p.worker += w
        val l = RecordingListener()
        val log = mutableListOf<String>()
        runBlocking { newOrchestrator(p, recoveryLog = { log += it }).run("go", l) }
        assertTrue(l.recovering.isEmpty())
        assertTrue(log.isEmpty())
    }

    @Test
    fun `continuation reports recovering with the extra turns`() {
        val pr = ScriptedPrompter { _, o -> o.first() }
        val p = ScriptedProvider()
        p.planner += call(Protocol.SUBMIT_PLAN, "p1", oneMilestonePlan())
        p.executor += call(Protocol.SUBMIT_TASKS, "e1", tasks(1))
        distinct.forEachIndexed { i, path -> p.worker += call("read_file", "w$i", """{"path":"$path"}""") }
        p.worker += call(Protocol.SUBMIT_RESULT, "ws", result(1))
        p.executor += call(Protocol.COMPLETE_MILESTONE, "e2", """{"notes":"done"}""")
        val l = RecordingListener()
        val log = mutableListOf<String>()
        runBlocking { newOrchestrator(p, turn3, pr, recoveryLog = { log += it }).run("go", l) }
        assertEquals(listOf("Continuing task (+3 turns)…"), l.recovering.map { it.second })
        assertTrue(log.toString(), log.any { it.contains("continue: task 1 +3 turns") })
    }

    @Test
    fun `truncated worker split reports output limit splitting`() {
        val p = splitProvider()
        p.worker += failedPlanner("truncated")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val l = RecordingListener()
        val log = mutableListOf<String>()
        runBlocking {
            newOrchestrator(
                p, splitLimits(), null, splitScratch, listOf(fakeReadTool(), fakeWriteTool()), RecordingGate(),
                fixedClock, fixedRandom(), recoveryLog = { log += it },
            ).run("go", l)
        }
        assertEquals(
            listOf(Triple(com.adb.stewart.agents.FaultKind.TRUNCATED, "Output limit hit, splitting task…", 0)), l.recovering,
        )
        assertTrue(log.toString(), log.all { it.startsWith("[run $rid] ") })
        assertTrue(log.toString(), log.any { it.contains("2 sub-tasks") && it.endsWith("done") })
    }

    @Test
    fun `turn limit split reports turn limit splitting and logs the timeout`() {
        val p = splitProvider()
        reads(p, 3, "w")
        p.recovery += recoveryCall("r1", "p1.txt", "p2.txt")
        p.worker += call(Protocol.SUBMIT_RESULT, "s1r", result(1)); p.worker += call(Protocol.SUBMIT_RESULT, "s2r", result(1))
        val pr = ScriptedPrompter { _, _ -> delay(60_000); "never" }
        val l = RecordingListener()
        val log = mutableListOf<String>()
        runBlocking {
            newOrchestrator(
                p, OrchestratorLimits(maxLevelModelTurns = 3, continueQuestionTimeout = 50.milliseconds), pr, splitScratch,
                listOf(fakeReadTool(), fakeWriteTool()), RecordingGate(), fixedClock, fixedRandom(), recoveryLog = { log += it },
            ).run("go", l)
        }
        assertEquals("Turn limit hit, splitting task…", l.recovering.single().second)
        assertTrue(log.toString(), log.any { it.contains("timed out") })
    }

    @Test
    fun `old scratch run dirs are pruned at run start with retention set`() {
        val old = splitScratch.runDir("20200101-000000-aaaa")
        val file = java.nio.file.Files.createDirectories(old.resolve("task-1-1")).resolve("x.txt")
        java.nio.file.Files.writeString(file, "x")
        val longAgo = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
        file.toFile().setLastModified(longAgo); old.resolve("task-1-1").toFile().setLastModified(longAgo); old.toFile().setLastModified(longAgo)
        val p = ScriptedProvider(); p.planner += text("x")
        runBlocking { newOrchestrator(p, scratch = splitScratch, retentionDays = 7).run("go", RecordingListener()) }
        assertFalse(java.nio.file.Files.exists(old))
    }

    @Test
    fun `old scratch run dirs are kept when retention is zero`() {
        val old = splitScratch.runDir("20200101-000000-bbbb")
        val file = java.nio.file.Files.createDirectories(old).resolve("x.txt")
        java.nio.file.Files.writeString(file, "x")
        val longAgo = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
        file.toFile().setLastModified(longAgo); old.toFile().setLastModified(longAgo)
        val p = ScriptedProvider(); p.planner += text("x")
        runBlocking { newOrchestrator(p, scratch = splitScratch, retentionDays = 0).run("go", RecordingListener()) }
        assertTrue(java.nio.file.Files.exists(old))
    }
}

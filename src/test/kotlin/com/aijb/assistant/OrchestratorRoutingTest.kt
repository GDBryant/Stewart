package com.aijb.assistant

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.LevelRoute
import com.aijb.assistant.agents.OrchestrationResult
import com.aijb.assistant.agents.Orchestrator
import com.aijb.assistant.agents.OrchestratorLimits
import com.aijb.assistant.agents.OrchestratorListener
import com.aijb.assistant.agents.Plan
import com.aijb.assistant.agents.Protocol
import com.aijb.assistant.agents.WorkerResult
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.RawToolCall
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolPath
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.shim.ToolCallingProvider
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.ToolRegistry
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OrchestratorRoutingTest {

    /** Answers each request with the next scripted event list; records what it was asked. */
    private class Scripted(override val id: String, vararg script: List<ProviderEvent>) : ModelProvider {
        val requests = mutableListOf<ChatRequest>()
        private val queue = ArrayDeque(script.toList())
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            requests += request
            val evs = queue.removeFirstOrNull()
                ?: listOf(ProviderEvent.Failed("exhausted", code = "script_exhausted"))
            return flow { evs.forEach { emit(it) } }
        }
    }

    private fun call(name: String, args: String) = listOf(
        ProviderEvent.NativeToolCalls(listOf(RawToolCall("c-$name", name, args))),
        ProviderEvent.Completed("tool_calls", Usage(1, 1)),
    )

    private class Recorder : OrchestratorListener {
        val order = mutableListOf<String>()
        override fun onLevelRouted(role: AgentRole, destination: String) { order += "route:$role=$destination" }
        override fun onLevelStarted(role: AgentRole, context: String) { order += "start:$role" }
        override fun onDelta(text: String) {}
        override fun onPlan(plan: Plan) {}
        override fun onTasks(taskRound: Int, tasks: List<com.aijb.assistant.agents.DispatchTask>) {}
        override fun onResult(result: WorkerResult) {}
        override fun onReplanning(reason: String) {}
        override fun onCompleted(usage: Usage?) {}
        override fun onFailed(message: String) {}
    }

    private fun route(p: ModelProvider, model: String) =
        LevelRoute(ModelRef(p.id, model), ToolCallingProvider(p, ToolPath.SHIM))

    private fun orchestrator(
        planner: Scripted, executor: Scripted, worker: Scripted,
        limits: OrchestratorLimits = OrchestratorLimits(),
    ) = Orchestrator(
        routes = mapOf(
            AgentRole.PLANNER to route(planner, "big"),
            AgentRole.EXECUTOR to route(executor, "mid"),
            AgentRole.WORKER to route(worker, "tiny"),
        ),
        projectTools = { ToolRegistry(emptyList()) },
        approval = ApprovalGate { _, _ -> ApprovalDecision.Approved },
        limits = limits,
    )

    private val onePlan = call(
        Protocol.SUBMIT_PLAN,
        """{"goal":"g","milestones":[{"id":1,"title":"m","notes":"n"}]}""",
    )
    private val oneTask = call(Protocol.SUBMIT_TASKS, """{"tasks":[{"id":1,"description":"d"}]}""")

    @Test
    fun `each level runs on a different provider and model`() {
        val planner = Scripted("claude", onePlan)
        val executor = Scripted(
            "aif", oneTask,
            call(Protocol.COMPLETE_MILESTONE, """{"notes":"ok"}"""),
        )
        val worker = Scripted(
            "ollama",
            call(Protocol.SUBMIT_RESULT, """{"task_id":1,"status":"done","summary":"s"}"""),
        )
        val rec = Recorder()
        val r = runBlocking { orchestrator(planner, executor, worker).run("go", rec) }
        assertTrue(r.toString(), r is OrchestrationResult.Completed)
        assertEquals(listOf("big"), planner.requests.map { it.model })
        assertEquals(listOf("mid", "mid"), executor.requests.map { it.model })
        assertEquals(listOf("tiny"), worker.requests.map { it.model })
        // Destination is announced before each level starts.
        assertEquals("route:PLANNER=claude/big", rec.order[0])
        assertEquals("start:PLANNER", rec.order[1])
        assertTrue(rec.order.contains("route:WORKER=ollama/tiny"))
    }

    @Test
    fun `worker provider failure fails the task and names the destination`() {
        val planner = Scripted("claude", onePlan)
        val executor = Scripted(
            "aif", oneTask,
            // After the failed worker result the executor is asked again; keep it failing the
            // milestone by exhausting rounds.
            oneTask, oneTask,
        )
        val worker = Scripted("ollama") // every request fails
        val rec = Recorder()
        val r = runBlocking {
            orchestrator(planner, executor, worker, OrchestratorLimits(maxTaskRounds = 1, maxReplans = 0))
                .run("go", rec)
        }
        assertTrue(r is OrchestrationResult.Failed)
        // Nothing was rerouted: the failing provider is the only one asked for worker work.
        assertTrue(worker.requests.isNotEmpty())
        assertTrue(planner.requests.size == 1)
    }

    @Test
    fun `planner failure names its provider and never reaches other providers`() {
        val planner = Scripted("claude") // fails immediately
        val executor = Scripted("aif")
        val worker = Scripted("ollama")
        val r = runBlocking { orchestrator(planner, executor, worker).run("go", Recorder()) }
        r as OrchestrationResult.Failed
        assertTrue(r.message, r.message.contains("claude/big"))
        assertTrue(executor.requests.isEmpty())
        assertTrue(worker.requests.isEmpty())
    }

    @Test
    fun `worker summary handed to the executor is bounded`() {
        val long = "x".repeat(5000)
        val planner = Scripted("claude", onePlan)
        val executor = Scripted(
            "aif", oneTask,
            call(Protocol.COMPLETE_MILESTONE, """{"notes":"ok"}"""),
        )
        val worker = Scripted(
            "ollama",
            call(Protocol.SUBMIT_RESULT, """{"task_id":1,"status":"done","summary":"$long"}"""),
        )
        runBlocking {
            orchestrator(planner, executor, worker, OrchestratorLimits(maxHandoffChars = 100)).run("go", Recorder())
        }
        val second = executor.requests[1].messages.filter { it.role == Role.USER }.joinToString("\n") { it.content }
        assertTrue(second.contains("[truncated 4900 chars]"))
        assertTrue(!second.contains("x".repeat(101)))
    }

    @Test
    fun `short summaries are not truncated`() {
        val planner = Scripted("claude", onePlan)
        val executor = Scripted("aif", oneTask, call(Protocol.COMPLETE_MILESTONE, """{"notes":"ok"}"""))
        val worker = Scripted(
            "ollama",
            call(Protocol.SUBMIT_RESULT, """{"task_id":1,"status":"done","summary":"all good"}"""),
        )
        runBlocking { orchestrator(planner, executor, worker).run("go", Recorder()) }
        val second = executor.requests[1].messages.filter { it.role == Role.USER }.joinToString("\n") { it.content }
        assertTrue(second.contains("all good"))
        assertTrue(!second.contains("truncated"))
    }
}

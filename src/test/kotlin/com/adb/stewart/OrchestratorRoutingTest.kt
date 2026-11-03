package com.adb.stewart

import com.adb.stewart.agents.AgentRole
import com.adb.stewart.agents.LevelRoute
import com.adb.stewart.agents.OrchestrationResult
import com.adb.stewart.agents.Orchestrator
import com.adb.stewart.agents.OrchestratorLimits
import com.adb.stewart.agents.OrchestratorListener
import com.adb.stewart.agents.Plan
import com.adb.stewart.agents.Protocol
import com.adb.stewart.agents.WorkerResult
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.Usage
import com.adb.stewart.shim.ToolCallingProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.ToolRegistry
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        override fun onTasks(taskRound: Int, tasks: List<com.adb.stewart.agents.DispatchTask>) {}
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
        // Every level, Worker included, fires exactly one route immediately followed by one start.
        assertTrue(rec.order.toString(), routedStartPairs(rec.order))
        assertEquals(
            listOf("start:PLANNER", "start:EXECUTOR", "start:WORKER", "start:EXECUTOR"),
            rec.order.filter { it.startsWith("start:") },
        )
    }

    @Test
    fun `pairing check rejects a start without a preceding route`() {
        assertTrue(routedStartPairs(listOf("route:WORKER=o/m", "start:WORKER")))
        assertFalse(routedStartPairs(listOf("start:WORKER", "route:WORKER=o/m", "start:WORKER")))
        assertFalse(routedStartPairs(listOf("route:WORKER=o/m", "start:EXECUTOR")))
        assertFalse(routedStartPairs(listOf("route:WORKER=o/m")))
    }

    private fun routedStartPairs(order: List<String>): Boolean =
        order.size % 2 == 0 && order.chunked(2).all { (r, s) ->
            r.startsWith("route:") && s == "start:" + r.removePrefix("route:").substringBefore('=')
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

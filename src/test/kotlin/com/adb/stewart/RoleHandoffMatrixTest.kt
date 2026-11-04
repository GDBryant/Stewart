package com.adb.stewart

import com.adb.stewart.agents.AgentRole
import com.adb.stewart.agents.DispatchTask
import com.adb.stewart.agents.Milestone
import com.adb.stewart.agents.OrchestrationResult
import com.adb.stewart.agents.Orchestrator
import com.adb.stewart.agents.OrchestratorLimits
import com.adb.stewart.agents.OrchestratorListener
import com.adb.stewart.agents.Plan
import com.adb.stewart.agents.Protocol
import com.adb.stewart.agents.ProtocolTool
import com.adb.stewart.agents.ProtocolTools
import com.adb.stewart.agents.RolePrompts
import com.adb.stewart.agents.RoleRouting
import com.adb.stewart.agents.WorkerResult
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.Usage
import com.adb.stewart.provider.aif.AifProvider
import com.adb.stewart.provider.claude.ClaudeProvider
import com.adb.stewart.provider.ollama.OllamaProvider
import com.adb.stewart.settings.ToolPathResolver
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopListener
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolRegistry
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.http.HttpClient
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Drives the protocol handoff through real providers (Ollama/AIF over fake HTTP, Claude through
 * the fake CLI) on every tool path. Claude has no NATIVE path (ToolPathResolver falls back to
 * SHIM); its two cells are the two wire formats a Claude turn can carry a call in: shim text and
 * a CLI `tool_use` block.
 */
class RoleHandoffMatrixTest {

    private data class Reply(val body: String, val status: Int = 200)

    private lateinit var ollamaServer: HttpServer
    private lateinit var aifServer: HttpServer
    private val ollamaBodies = mutableListOf<String>()
    private val aifBodies = mutableListOf<String>()
    private val ollamaQueue = ArrayDeque<Reply>()
    private val aifQueue = ArrayDeque<Reply>()
    /** Requests that found no scripted reply: a misconfigured scenario, never a passing negative. */
    private val unexpected = mutableListOf<String>()
    private val fakeFile = File("src/test/resources/claude/fake-claude.sh").absoluteFile

    @Before
    fun setUp() {
        fakeFile.setExecutable(true)
        ollamaServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        ollamaServer.createContext("/api/chat") { ex ->
            val req = ex.requestBody.readBytes().decodeToString()
            val reply = synchronized(this) {
                ollamaBodies += req
                ollamaQueue.removeFirstOrNull() ?: Reply("""{"error":"unexpected"}""", 500)
                    .also { unexpected += "ollama: ${req.take(200)}" }
            }
            val body = (reply.body + "\n").toByteArray()
            ex.sendResponseHeaders(reply.status, body.size.toLong())
            ex.responseBody.use { it.write(body) }
        }
        ollamaServer.createContext("/api/tags") { ex ->
            val body = ("""{"models":[{"name":"m","capabilities":["completion","tools"]},""" +
                """{"name":"n","capabilities":["completion","tools"]},""" +
                """{"name":"s","capabilities":["completion"]}]}""").toByteArray()
            ex.sendResponseHeaders(200, body.size.toLong())
            ex.responseBody.use { it.write(body) }
        }
        ollamaServer.start()
        aifServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        aifServer.createContext("/api/proxy/v1/chat/completions") { ex ->
            val req = ex.requestBody.bufferedReader().readText()
            val reply = synchronized(this) {
                aifBodies += req
                aifQueue.removeFirstOrNull() ?: Reply("""{"error":"unexpected"}""", 500)
                    .also { unexpected += "aif: ${req.take(200)}" }
            }
            val body = reply.body.toByteArray()
            ex.sendResponseHeaders(reply.status, body.size.toLong())
            ex.responseBody.use { it.write(body) }
        }
        aifServer.start()
    }

    @After
    fun tearDown() {
        ollamaServer.stop(0)
        aifServer.stop(0)
    }

    private fun ollama() = OllamaProvider("http://127.0.0.1:${ollamaServer.address.port}")

    private fun aif() = AifProvider(
        "http://127.0.0.1:${aifServer.address.port}/api/proxy/v1", listOf("m", "n", "s"), { "k" },
        HttpClient.newHttpClient())

    private fun claude(rec: File, fix: File) = ClaudeProvider(
        cliPath = fakeFile.absolutePath,
        extraEnv = mapOf("FAKE_RECORD" to rec.absolutePath, "FAKE_FIXTURE_DIR" to fix.absolutePath))

    private fun tmp(prefix: String) = Files.createTempDirectory(prefix).toFile().also { it.deleteOnExit() }

    private fun q(s: String) = JsonPrimitive(s).toString()

    // --- wire formats --------------------------------------------------------------

    private fun ollamaNativeCall(name: String, args: String) =
        """{"message":{"tool_calls":[{"function":{"name":"$name","arguments":$args}}]},"done":true,"done_reason":"tool_calls"}"""

    private val ollamaDone = """{"message":{"content":"done"},"done":true,"done_reason":"stop"}"""

    private fun ollamaText(text: String) =
        """{"message":{"content":${q(text)}},"done":true,"done_reason":"stop"}"""

    private fun ollamaShimCall(name: String, args: String) =
        ollamaText("<tool_call> {\"name\":\"$name\",\"arguments\":$args} </tool_call>")

    private fun aifNativeCall(name: String, args: String, id: String = "c1") =
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"$id\",\"function\":{\"name\":\"$name\",\"arguments\":${q(args)}}}]}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\n"

    private fun aifNativeCalls(vararg calls: Triple<String, String, String>) =
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[" +
            calls.mapIndexed { i, (id, name, args) ->
                "{\"index\":$i,\"id\":\"$id\",\"function\":{\"name\":\"$name\",\"arguments\":${q(args)}}}"
            }.joinToString(",") + "]}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\n"

    private val aifDone =
        "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n"

    private fun aifText(text: String) =
        "data: {\"choices\":[{\"delta\":{\"content\":${q(text)}},\"finish_reason\":null}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n"

    private fun aifShimCall(name: String, args: String) =
        aifText("<tool_call>\n{\"name\":\"$name\",\"arguments\":$args}\n</tool_call>")

    private fun claudeText(text: String) =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":${q(text)}}},\"api_message_id\":\"m1\"}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}\n"

    private fun claudeTextualCall(name: String, args: String) =
        claudeText("<tool_call> {\"name\":\"$name\",\"arguments\":$args} </tool_call>")

    /** A CLI turn that emits `tool_use`; the CLI refuses it (no tools) and would carry on with an apology. */
    private fun claudeNativeCall(name: String, args: String, id: String = "toolu_1") =
        "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[" +
            "{\"type\":\"tool_use\",\"id\":\"$id\",\"name\":\"$name\",\"input\":$args}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[" +
            "{\"type\":\"tool_result\",\"tool_use_id\":\"$id\",\"is_error\":true,\"content\":\"No such tool available\"}]}}\n" +
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"content\":[{\"type\":\"text\",\"text\":\"apology\"}]}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}\n"

    private val claudeDone = claudeText("done")

    // --- single-level cells (ToolLoop on each provider/path) -----------------------

    private val planArgs = """{"goal":"g","milestones":[{"id":1,"title":"t","notes":"n"}]}"""
    private val tasksArgs = """{"tasks":[{"id":1,"description":"d","files":["f.kt"],"depends_on":[]}]}"""
    private val completeArgs = """{"notes":"evidence"}"""
    private val resultArgs = """{"task_id":1,"status":"done","summary":"s"}"""

    private class RoleCase(
        val role: AgentRole,
        val toolName: String,
        val args: String,
        val tools: List<Tool>,
        val prompt: String,
    ) {
        fun accepted(): Any? = tools.filterIsInstance<ProtocolTool<*>>().first { it.spec.name == toolName }.accepted
    }

    private fun cases() = listOf(
        RoleCase(AgentRole.PLANNER, Protocol.SUBMIT_PLAN, planArgs,
            listOf(ProtocolTools.planTool(1, 8)), Protocol.PLANNER),
        RoleCase(AgentRole.EXECUTOR, Protocol.SUBMIT_TASKS, tasksArgs,
            listOf(ProtocolTools.tasksTool(10), ProtocolTools.completeMilestoneTool()), Protocol.EXECUTOR),
        RoleCase(AgentRole.EXECUTOR, Protocol.COMPLETE_MILESTONE, completeArgs,
            listOf(ProtocolTools.tasksTool(10), ProtocolTools.completeMilestoneTool()), Protocol.EXECUTOR),
        RoleCase(AgentRole.WORKER, Protocol.SUBMIT_RESULT, resultArgs,
            listOf(ProtocolTools.resultTool(1)), Protocol.WORKER),
    )

    private fun runCell(
        ref: ModelRef,
        inner: ModelProvider,
        overrides: Map<String, String>,
        case: RoleCase,
    ): LoopResult {
        val route = RoleRouting.routeFor(ref, listOf(inner), overrides)
        assertNotNull(route)
        val loop = ToolLoop(route!!.provider, ToolRegistry(case.tools),
            ApprovalGate { _, _ -> ApprovalDecision.Approved },
            rolePrompt = RolePrompts.forRole(case.role) + " " + case.prompt)
        return runBlocking {
            loop.run(ref.modelId, listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        }
    }

    private fun assertCell(case: RoleCase, result: LoopResult) {
        assertTrue("$case: $result", result is LoopResult.Completed)
        assertNotNull("${case.toolName} not accepted", case.accepted())
    }

    @Test
    fun `ollama native handoffs`() = runBlocking {
        for (case in cases()) {
            ollamaQueue += Reply(ollamaNativeCall(case.toolName, case.args))
            ollamaQueue += Reply(ollamaDone)
            val p = ollama()
            p.listModels()
            val before = ollamaBodies.size
            assertCell(case, runCell(ModelRef("ollama", "m"), p, emptyMap(), case))
            val followup = ollamaBodies[before + 1]
            assertTrue(followup.contains("\"role\":\"tool\""))
            assertTrue(followup.contains("accepted"))
        }
        assertTrue(unexpected.toString(), unexpected.isEmpty())
    }

    @Test
    fun `ollama shim handoffs`() {
        for (case in cases()) {
            ollamaQueue += Reply(ollamaShimCall(case.toolName, case.args))
            ollamaQueue += Reply(ollamaDone)
            val before = ollamaBodies.size
            assertCell(case, runCell(ModelRef("ollama", "m"), ollama(), mapOf("ollama/m" to "SHIM"), case))
            val followup = ollamaBodies[before + 1]
            assertTrue(followup.contains("<tool_response>"))
            assertTrue(followup.contains("accepted"))
        }
        assertTrue(unexpected.toString(), unexpected.isEmpty())
    }

    @Test
    fun `aif native handoffs`() {
        for (case in cases()) {
            aifQueue += Reply(aifNativeCall(case.toolName, case.args))
            aifQueue += Reply(aifDone)
            val before = aifBodies.size
            assertCell(case, runCell(ModelRef("aif", "m"), aif(), emptyMap(), case))
            val followup = aifBodies[before + 1]
            assertTrue(followup.contains("\"role\":\"tool\""))
            assertTrue(followup.contains("accepted"))
            assertTrue(followup.contains("c1"))
        }
        assertTrue(unexpected.toString(), unexpected.isEmpty())
    }

    @Test
    fun `aif shim handoffs`() {
        for (case in cases()) {
            aifQueue += Reply(aifShimCall(case.toolName, case.args))
            aifQueue += Reply(aifDone)
            val before = aifBodies.size
            assertCell(case, runCell(ModelRef("aif", "m"), aif(), mapOf("aif/m" to "SHIM"), case))
            val followup = aifBodies[before + 1]
            assertTrue(followup.contains("<tool_response>"))
            assertTrue(followup.contains("accepted"))
        }
        assertTrue(unexpected.toString(), unexpected.isEmpty())
    }

    @Test
    fun `claude shim textual handoffs`() {
        for (case in cases()) {
            val rec = tmp("stewart-mtx-rec")
            val fix = tmp("stewart-mtx-fix")
            File(fix, "1.json").writeText(claudeTextualCall(case.toolName, case.args))
            File(fix, "2.json").writeText(claudeDone)
            assertCell(case, runCell(ModelRef("claude", "m"), claude(rec, fix), emptyMap(), case))
            assertTrue(File(rec, "stdin-2").readText().contains("accepted"))
        }
    }

    @Test
    fun `claude shim native tool_use handoffs`() {
        for (case in cases()) {
            val rec = tmp("stewart-mtx-rec")
            val fix = tmp("stewart-mtx-fix")
            File(fix, "1.json").writeText(claudeNativeCall(case.toolName, case.args))
            File(fix, "2.json").writeText(claudeDone)
            assertCell(case, runCell(ModelRef("claude", "m"), claude(rec, fix), emptyMap(), case))
            assertTrue(File(rec, "stdin-2").readText().contains("accepted"))
        }
    }

    @Test
    fun `invalid protocol args are returned to the model`() = runBlocking {
        val case = cases().first { it.toolName == Protocol.SUBMIT_RESULT }
        ollamaQueue += Reply(ollamaNativeCall(Protocol.SUBMIT_RESULT, """{"task_id":2,"status":"done","summary":"s"}"""))
        ollamaQueue += Reply(ollamaNativeCall(Protocol.SUBMIT_RESULT, resultArgs))
        ollamaQueue += Reply(ollamaDone)
        val p = ollama()
        p.listModels()
        val result = runCell(ModelRef("ollama", "m"), p, emptyMap(), case)
        assertTrue(result is LoopResult.Completed)
        assertTrue(ollamaBodies[1].contains("does not match"))
        assertNotNull(case.accepted())
    }

    @Test
    fun `malformed native args fail invalid_tool_call`() = runBlocking {
        aifQueue += Reply("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"submit_plan\",\"arguments\":\"{bad\"}}]}}]}\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\n")
        val case = cases().first { it.toolName == Protocol.SUBMIT_PLAN }
        val result = runCell(ModelRef("aif", "m"), aif(), emptyMap(), case)
        assertTrue(result is LoopResult.Failed)
        assertEquals("invalid_tool_call", (result as LoopResult.Failed).code)
    }

    @Test
    fun `claude native override resolves shim`() {
        val p = claude(tmp("stewart-mtx-rec"), tmp("stewart-mtx-fix"))
        assertEquals(ToolPath.SHIM, ToolPathResolver.resolve(
            ModelRef("claude", "m"), p, mapOf("claude/m" to "NATIVE")))
        val rec = tmp("stewart-mtx-rec")
        val fix = tmp("stewart-mtx-fix")
        val case = cases().first { it.toolName == Protocol.SUBMIT_PLAN }
        File(fix, "1.json").writeText(claudeTextualCall(case.toolName, case.args))
        File(fix, "2.json").writeText(claudeDone)
        assertCell(case, runCell(ModelRef("claude", "m"), claude(rec, fix),
            mapOf("claude/m" to "NATIVE"), case))
        assertTrue(File(rec, "stdin-2").readText().contains("accepted"))
    }

    // --- full orchestrations: every role x provider x tool path ---------------------

    /** One provider + tool path (+ wire format, for Claude) a role can be bound to. */
    private enum class Cell(val providerId: String, val model: String, val native: Boolean) {
        OLLAMA_NATIVE("ollama", "n", true),
        OLLAMA_SHIM("ollama", "s", false),
        AIF_NATIVE("aif", "n", true),
        AIF_SHIM("aif", "s", false),
        CLAUDE_TEXT("claude", "m", false),
        CLAUDE_TOOL_USE("claude", "m", false);

        val ref get() = ModelRef(providerId, model)
        /** Carries calls as shim text the provider's parser must extract. */
        val textual get() = this == OLLAMA_SHIM || this == AIF_SHIM || this == CLAUDE_TEXT
    }

    private val overrides = mapOf("ollama/s" to "SHIM", "aif/s" to "SHIM")

    private val goal = "GOAL_X"
    private val msTitle = "MS_TITLE_X"
    private val msNotes = "NOTES_X"
    private val taskDesc = "TASK_DESC_X"
    private val taskFile = "FILE_X.kt"
    private val summary = "SUMMARY_X"
    private val evidence = "EVIDENCE_X"
    private val mPlanArgs = """{"goal":"$goal","milestones":[{"id":1,"title":"$msTitle","notes":"$msNotes"}]}"""
    private val mTasksArgs = """{"tasks":[{"id":1,"description":"$taskDesc","files":["$taskFile"],"depends_on":[]}]}"""
    private val mResultArgs = """{"task_id":1,"status":"done","summary":"$summary"}"""
    private val mCompleteArgs = """{"notes":"$evidence"}"""

    private val expectedPlan = Plan(goal, listOf(Milestone(1, msTitle, msNotes)))
    private val expectedTasks = listOf(DispatchTask(1, taskDesc, listOf(taskFile), emptyList()))

    private val toolDescriptions = mapOf(
        Protocol.SUBMIT_PLAN to "Submit the full plan: goal plus ordered",
        Protocol.SUBMIT_TASKS to "Dispatch concrete tasks to the Worker.",
        Protocol.COMPLETE_MILESTONE to "Declare the current milestone complete.",
        Protocol.SUBMIT_RESULT to "Report the outcome of the given task.",
    )
    private val roleTools = mapOf(
        AgentRole.PLANNER to setOf(Protocol.SUBMIT_PLAN),
        AgentRole.EXECUTOR to setOf(Protocol.SUBMIT_TASKS, Protocol.COMPLETE_MILESTONE),
        AgentRole.WORKER to setOf(Protocol.SUBMIT_RESULT),
    )
    private val roleMarker = mapOf(
        AgentRole.PLANNER to RolePrompts.PLANNER.take(30),
        AgentRole.EXECUTOR to RolePrompts.EXECUTOR.take(30),
        AgentRole.WORKER to RolePrompts.WORKER.take(30),
    )

    private fun callReply(cell: Cell, name: String, args: String, id: String) = Reply(when (cell) {
        Cell.OLLAMA_NATIVE -> ollamaNativeCall(name, args)
        Cell.OLLAMA_SHIM -> ollamaShimCall(name, args)
        Cell.AIF_NATIVE -> aifNativeCall(name, args, id)
        Cell.AIF_SHIM -> aifShimCall(name, args)
        Cell.CLAUDE_TEXT -> claudeTextualCall(name, args)
        Cell.CLAUDE_TOOL_USE -> claudeNativeCall(name, args, id)
    })

    private fun textReply(cell: Cell, text: String) = Reply(when (cell.providerId) {
        "ollama" -> ollamaText(text)
        "aif" -> aifText(text)
        else -> claudeText(text)
    })

    private fun failReply(cell: Cell) = when (cell.providerId) {
        "ollama", "aif" -> Reply("""{"error":"BOOM_X"}""", 500)
        else -> Reply("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"BOOM_X\",\"stop_reason\":\"end_turn\",\"usage\":{}}\n")
    }

    /** Call with arguments that are not JSON (or, for a CLI tool_use block, not an object). */
    private fun malformedReply(cell: Cell, name: String) = Reply(when (cell) {
        Cell.OLLAMA_NATIVE ->
            """{"message":{"tool_calls":[{"function":{"name":"$name","arguments":"{bad"}}]},"done":true,"done_reason":"tool_calls"}"""
        Cell.OLLAMA_SHIM -> ollamaText("<tool_call>{\"name\":\"$name\",\"arguments\":{bad</tool_call>")
        Cell.AIF_NATIVE -> aifNativeCall(name, "{bad", "call_bad")
        Cell.AIF_SHIM -> aifText("<tool_call>{\"name\":\"$name\",\"arguments\":{bad</tool_call>")
        Cell.CLAUDE_TEXT -> claudeText("<tool_call>{\"name\":\"$name\",\"arguments\":{bad</tool_call>")
        Cell.CLAUDE_TOOL_USE -> claudeNativeCall(name, "\"{bad\"", "toolu_bad")
    })

    /** One orchestration's fakes: replies are scripted in the order the levels will call them. */
    private inner class Scenario {
        val rec = tmp("stewart-mtx-rec")
        val fix = tmp("stewart-mtx-fix")
        private var claudeCalls = 0
        val order = mutableListOf<Pair<Cell, String>>()

        init {
            synchronized(this@RoleHandoffMatrixTest) {
                ollamaBodies.clear(); aifBodies.clear(); ollamaQueue.clear(); aifQueue.clear(); unexpected.clear()
            }
        }

        fun script(cell: Cell, label: String, reply: Reply) {
            order += cell to label
            when (cell.providerId) {
                "ollama" -> ollamaQueue += reply
                "aif" -> aifQueue += reply
                else -> File(fix, "${++claudeCalls}.json").writeText(reply.body)
            }
        }

        fun routes(p: Cell, e: Cell, w: Cell): Map<AgentRole, com.adb.stewart.agents.LevelRoute> {
            val o = ollama()
            runBlocking { o.listModels() }
            val providers = listOf(o, aif(), claude(rec, fix))
            return mapOf(AgentRole.PLANNER to p, AgentRole.EXECUTOR to e, AgentRole.WORKER to w)
                .mapValues { (_, c) -> RoleRouting.routeFor(c.ref, providers, overrides)!! }
        }

        /** Request bodies by label (Claude: system prompt file + stdin); asserts nothing extra was sent. */
        fun bodies(): Map<String, String> {
            assertTrue("unexpected requests: $unexpected", unexpected.isEmpty())
            assertTrue("unconsumed ollama replies: ${ollamaQueue.size}", ollamaQueue.isEmpty())
            assertTrue("unconsumed aif replies: ${aifQueue.size}", aifQueue.isEmpty())
            val sent = File(rec, "count").takeIf { it.exists() }?.readText()?.trim()?.toInt() ?: 0
            assertEquals("claude requests", claudeCalls, sent)
            var o = 0; var a = 0; var c = 0
            return order.associate { (cell, label) ->
                label to when (cell.providerId) {
                    "ollama" -> ollamaBodies[o++]
                    "aif" -> aifBodies[a++]
                    else -> {
                        c++
                        File(rec, "sysprompt-$c").let { if (it.exists()) it.readText() else "" } +
                            "\n" + File(rec, "stdin-$c").readText()
                    }
                }
            }
        }
    }

    private class Capture : OrchestratorListener {
        var plan: Plan? = null
        val tasks = mutableListOf<List<DispatchTask>>()
        val results = mutableListOf<WorkerResult>()
        val routed = mutableListOf<Pair<AgentRole, String>>()
        override fun onDelta(text: String) {}
        override fun onLevelRouted(role: AgentRole, destination: String) { routed += role to destination }
        override fun onLevelStarted(role: AgentRole, context: String) {}
        override fun onPlan(plan: Plan) { this.plan = plan }
        override fun onTasks(taskRound: Int, tasks: List<DispatchTask>) { this.tasks += tasks }
        override fun onResult(result: WorkerResult) { results += result }
        override fun onReplanning(reason: String) {}
        override fun onCompleted(usage: Usage?) {}
        override fun onFailed(message: String) {}
    }

    private fun orchestrator(
        routes: Map<AgentRole, com.adb.stewart.agents.LevelRoute>,
        limits: OrchestratorLimits = OrchestratorLimits(maxReplans = 0, maxLevelModelTurns = 1, maxRecoveriesPerRun = 0),
    ) = Orchestrator(routes, { ToolRegistry(emptyList()) },
        ApprovalGate { _, _ -> ApprovalDecision.Approved }, limits)

    /** The level's request names its role, offers exactly its protocol tools, in the cell's format. */
    private fun assertRequest(body: String, role: AgentRole, cell: Cell, ctx: String) {
        assertTrue("$ctx: role prompt", body.contains(roleMarker.getValue(role)))
        roleMarker.filterKeys { it != role }.values.forEach {
            assertFalse("$ctx: foreign role prompt '$it'", body.contains(it))
        }
        val own = roleTools.getValue(role)
        toolDescriptions.forEach { (name, desc) ->
            assertEquals("$ctx: tool $name offered", name in own, body.contains(desc))
        }
        if (cell.native) {
            assertTrue("$ctx: native tools array", body.contains("\"tools\":["))
            assertFalse("$ctx: shim block on native path", body.contains("<tools>"))
        } else {
            assertTrue("$ctx: shim <tools> block", body.contains("<tools>"))
            assertFalse("$ctx: native tools on shim path", body.contains("\"tools\":[{"))
        }
    }

    /** Every assistant tool call in [messages] is answered by exactly one tool message before the next turn. */
    private fun assertPaired(messages: List<ChatMessage>, ctx: String) {
        val open = mutableListOf<String>()
        for (m in messages) {
            when (m.role) {
                Role.TOOL -> assertTrue("$ctx: orphan tool result ${m.toolCallId}", open.remove(m.toolCallId))
                else -> {
                    assertTrue("$ctx: unanswered calls $open", open.isEmpty())
                    open += m.toolCalls.map { it.id }
                }
            }
        }
        assertTrue("$ctx: unanswered calls $open", open.isEmpty())
    }

    /** Same check on an OpenAI-format request body (what AIF would validate). */
    private fun assertPairedBody(body: String, ctx: String) {
        val open = mutableListOf<String>()
        for (el in Json.parseToJsonElement(body).jsonObject.getValue("messages").jsonArray) {
            val m = el.jsonObject
            if (m["role"]?.jsonPrimitive?.content == "tool") {
                assertTrue("$ctx: orphan tool result", open.remove(m["tool_call_id"]?.jsonPrimitive?.content))
            } else {
                assertTrue("$ctx: unanswered calls $open", open.isEmpty())
                m["tool_calls"]?.jsonArray?.forEach { open += it.jsonObject.getValue("id").jsonPrimitive.content }
            }
        }
        assertTrue("$ctx: unanswered calls $open", open.isEmpty())
    }

    /** Scripts the happy path P -> E1 (submit_tasks) -> W -> E2 (complete_milestone). */
    private fun Scenario.scriptHappy(p: Cell, e: Cell, w: Cell) {
        script(p, "P", callReply(p, Protocol.SUBMIT_PLAN, mPlanArgs, "call_P"))
        script(e, "E1", callReply(e, Protocol.SUBMIT_TASKS, mTasksArgs, "call_E1"))
        script(w, "W", callReply(w, Protocol.SUBMIT_RESULT, mResultArgs, "call_W"))
        script(e, "E2", callReply(e, Protocol.COMPLETE_MILESTONE, mCompleteArgs, "call_E2"))
    }

    private fun checkHappy(p: Cell, e: Cell, w: Cell) {
        val ctx = "P=$p E=$e W=$w"
        val s = Scenario()
        s.scriptHappy(p, e, w)
        val cap = Capture()
        val res = runBlocking { orchestrator(s.routes(p, e, w)).run("build it", cap) }
        assertTrue("$ctx: $res", res is OrchestrationResult.Completed)
        // Emitted upstream, resolved identically on every path.
        assertEquals("$ctx: plan", expectedPlan, cap.plan)
        assertEquals("$ctx: tasks", listOf(expectedTasks), cap.tasks)
        assertEquals("$ctx: results", listOf(WorkerResult(1, "done", summary)), cap.results)
        assertEquals("$ctx: routing", listOf(
            AgentRole.PLANNER to p.ref.encode(), AgentRole.EXECUTOR to e.ref.encode(),
            AgentRole.WORKER to w.ref.encode(), AgentRole.EXECUTOR to e.ref.encode(),
        ), cap.routed)
        assertTrue("$ctx: summary", res.messages.last().content.contains("[1] $msTitle: $evidence"))
        assertPaired(res.messages, ctx)
        // Received downstream: each level's actual request.
        val b = s.bodies()
        assertRequest(b.getValue("P"), AgentRole.PLANNER, p, "$ctx P")
        assertRequest(b.getValue("E1"), AgentRole.EXECUTOR, e, "$ctx E1")
        assertRequest(b.getValue("W"), AgentRole.WORKER, w, "$ctx W")
        assertRequest(b.getValue("E2"), AgentRole.EXECUTOR, e, "$ctx E2")
        assertTrue("$ctx P request", b.getValue("P").contains("build it"))
        listOf("Goal: $goal", "Milestone 1: $msTitle", "Definition of done: $msNotes").forEach {
            assertTrue("$ctx E1 lacks '$it'", b.getValue("E1").contains(it))
        }
        listOf(goal, taskDesc, taskFile).forEach {
            assertTrue("$ctx W lacks '$it'", b.getValue("W").contains(it))
        }
        assertFalse("$ctx W sees the plan protocol", b.getValue("W").contains(Protocol.SUBMIT_PLAN))
        val e2 = b.getValue("E2")
        assertTrue("$ctx E2 lacks worker result", e2.contains("- task 1 [done]: $summary"))
        assertTrue("$ctx E2 lacks own round-1 call", e2.contains(taskDesc) && e2.contains("accepted"))
        when {
            e.native -> assertTrue("$ctx E2 tool message", e2.contains("\"role\":\"tool\""))
            else -> assertTrue("$ctx E2 tool_response", e2.contains("<tool_response>"))
        }
        if (e == Cell.AIF_NATIVE) {
            assertTrue("$ctx E2 call id", e2.contains("call_E1"))
            assertPairedBody(e2, "$ctx E2")
        }
    }

    private fun collect(label: String, combos: List<List<Cell>>, check: (List<Cell>) -> Unit) {
        val failures = mutableListOf<String>()
        for (combo in combos) {
            try {
                check(combo)
            } catch (e: AssertionError) {
                failures += "$combo: ${e.message}"
            }
        }
        if (failures.isNotEmpty()) {
            fail("$label: ${failures.size}/${combos.size} failed:\n" + failures.take(15).joinToString("\n"))
        }
    }

    private val cells = Cell.entries.toList()
    private val allCombos = cells.flatMap { p -> cells.flatMap { e -> cells.map { w -> listOf(p, e, w) } } }

    @Test
    fun `every role x provider x tool path hands off through the protocol`() {
        assertEquals(216, allCombos.size)
        collect("happy matrix", allCombos) { (p, e, w) -> checkHappy(p, e, w) }
    }

    @Test
    fun `prior mixed-provider history reaches every planner cell`() {
        // First run mixes three providers; its transcript becomes the next run's history, as in ChatSession.
        val s1 = Scenario()
        s1.scriptHappy(Cell.CLAUDE_TOOL_USE, Cell.AIF_NATIVE, Cell.OLLAMA_NATIVE)
        val first = runBlocking {
            orchestrator(s1.routes(Cell.CLAUDE_TOOL_USE, Cell.AIF_NATIVE, Cell.OLLAMA_NATIVE)).run("first", Capture())
        }
        assertTrue(first is OrchestrationResult.Completed)
        val history = listOf(ChatMessage(Role.USER, "first")) + first.messages.filter { it.role != Role.SYSTEM }
        assertPaired(history, "history")
        assertEquals("call ids unique", history.flatMap { m -> m.toolCalls.map { it.id } }.let { it.size },
            history.flatMap { m -> m.toolCalls.map { it.id } }.toSet().size)
        collect("history", cells.map { listOf(it) }) { (p) ->
            val s = Scenario()
            s.scriptHappy(p, Cell.AIF_SHIM, Cell.OLLAMA_SHIM)
            val res = runBlocking {
                orchestrator(s.routes(p, Cell.AIF_SHIM, Cell.OLLAMA_SHIM)).run("second", Capture(), history)
            }
            assertTrue("$p: $res", res is OrchestrationResult.Completed)
            val body = s.bodies().getValue("P")
            assertTrue("$p: prior task in history", body.contains(taskDesc))
            assertTrue("$p: prior summary in history", body.contains("Done. Goal: $goal"))
            assertTrue("$p: new request", body.contains("second"))
            if (p == Cell.AIF_NATIVE) assertPairedBody(body, "$p planner")
        }
    }

    @Test
    fun `a second call in the terminal turn is answered before the next round`() {
        // Executor emits submit_tasks and complete_milestone together: the first one ends the level,
        // the second must still get a tool result or the round-2 request (and saved history) is invalid.
        val s = Scenario()
        s.script(Cell.AIF_NATIVE, "P", callReply(Cell.AIF_NATIVE, Protocol.SUBMIT_PLAN, mPlanArgs, "call_P"))
        s.script(Cell.AIF_NATIVE, "E1", Reply(aifNativeCalls(
            Triple("call_T", Protocol.SUBMIT_TASKS, mTasksArgs),
            Triple("call_C", Protocol.COMPLETE_MILESTONE, mCompleteArgs),
        )))
        s.script(Cell.OLLAMA_NATIVE, "W", callReply(Cell.OLLAMA_NATIVE, Protocol.SUBMIT_RESULT, mResultArgs, "x"))
        s.script(Cell.AIF_NATIVE, "E2", callReply(Cell.AIF_NATIVE, Protocol.COMPLETE_MILESTONE, mCompleteArgs, "call_E2"))
        val cap = Capture()
        val res = runBlocking {
            orchestrator(s.routes(Cell.AIF_NATIVE, Cell.AIF_NATIVE, Cell.OLLAMA_NATIVE)).run("go", cap)
        }
        assertTrue("$res", res is OrchestrationResult.Completed)
        assertEquals(listOf(expectedTasks), cap.tasks)
        assertPaired(res.messages, "transcript")
        val e2 = s.bodies().getValue("E2")
        assertPairedBody(e2, "E2")
        assertTrue(e2.contains("call_C"))
        assertTrue(e2.contains("Not executed"))
    }

    @Test
    fun `a lone terminal call is not given an extra result`() {
        val s = Scenario()
        s.scriptHappy(Cell.AIF_NATIVE, Cell.AIF_NATIVE, Cell.AIF_NATIVE)
        val res = runBlocking {
            orchestrator(s.routes(Cell.AIF_NATIVE, Cell.AIF_NATIVE, Cell.AIF_NATIVE)).run("go", Capture())
        }
        assertTrue(res is OrchestrationResult.Completed)
        assertFalse(res.messages.any { it.content.contains("Not executed") })
        assertFalse(s.bodies().getValue("E2").contains("Not executed"))
    }

    // --- negatives: each role x cell fails its handoff cleanly ----------------------

    private enum class Fault { NO_CALL, UNKNOWN_TOOL, FOREIGN_TOOL, MALFORMED, PROVIDER_ERROR }

    /** Scripts the faulty level's request(s), labelled by role. */
    private fun Scenario.scriptFault(cell: Cell, role: AgentRole, fault: Fault) {
        val label = role.name
        val own = roleTools.getValue(role).first()
        val reply = when (fault) {
            Fault.NO_CALL -> textReply(cell, "NO_CALL_X")
            Fault.UNKNOWN_TOOL -> callReply(cell, "no_such_tool", "{}", "call_U")
            // A downstream role calling an upstream role's protocol tool (and vice versa).
            Fault.FOREIGN_TOOL -> callReply(cell,
                if (role == AgentRole.WORKER) Protocol.SUBMIT_PLAN else Protocol.SUBMIT_RESULT,
                if (role == AgentRole.WORKER) mPlanArgs else mResultArgs, "call_F")
            Fault.MALFORMED -> malformedReply(cell, own)
            Fault.PROVIDER_ERROR -> failReply(cell)
        }
        script(cell, label, reply)
        // The shim re-asks once when a turn looks like a failed call attempt.
        val retried = cell.textual && fault in setOf(Fault.UNKNOWN_TOOL, Fault.FOREIGN_TOOL, Fault.MALFORMED)
        if (retried) script(cell, "$label-retry", reply)
    }

    private fun checkFault(cell: Cell, role: AgentRole, fault: Fault) {
        val ctx = "$role on $cell: $fault"
        // Healthy roles on a fixed mixed set so the fault is the only variable.
        val p = if (role == AgentRole.PLANNER) cell else Cell.CLAUDE_TEXT
        val e = if (role == AgentRole.EXECUTOR) cell else Cell.AIF_NATIVE
        val w = if (role == AgentRole.WORKER) cell else Cell.OLLAMA_SHIM
        val s = Scenario()
        when (role) {
            AgentRole.PLANNER -> s.scriptFault(p, role, fault)
            AgentRole.EXECUTOR -> {
                s.script(p, "P", callReply(p, Protocol.SUBMIT_PLAN, mPlanArgs, "call_P"))
                s.scriptFault(e, role, fault)
            }
            AgentRole.WORKER -> {
                s.script(p, "P", callReply(p, Protocol.SUBMIT_PLAN, mPlanArgs, "call_P"))
                s.script(e, "E1", callReply(e, Protocol.SUBMIT_TASKS, mTasksArgs, "call_E1"))
                s.scriptFault(w, role, fault)
                s.script(e, "E2", callReply(e, Protocol.COMPLETE_MILESTONE, mCompleteArgs, "call_E2"))
            }
        }
        val cap = Capture()
        val res = runBlocking { orchestrator(s.routes(p, e, w)).run("build it", cap) }
        val bodies = s.bodies()
        val label = cell.ref.encode()
        val detail: String
        when (role) {
            AgentRole.PLANNER -> {
                assertTrue("$ctx: $res", res is OrchestrationResult.Failed)
                detail = (res as OrchestrationResult.Failed).message
                assertTrue("$ctx: $detail", detail.startsWith("Planner: "))
                assertEquals("$ctx: no handoff", null, cap.plan)
            }
            AgentRole.EXECUTOR -> {
                assertTrue("$ctx: $res", res is OrchestrationResult.Failed)
                detail = (res as OrchestrationResult.Failed).message.substringBefore("; fault: ")
                assertTrue("$ctx: $detail",
                    detail.startsWith("re-planning budget exhausted: milestone '$msTitle' (1): "))
                assertTrue("$ctx: no dispatch", cap.tasks.isEmpty())
            }
            AgentRole.WORKER -> {
                assertTrue("$ctx: $res", res is OrchestrationResult.Completed)
                val r = cap.results.single()
                assertEquals("$ctx", "failed", r.status)
                assertTrue("$ctx: ${r.summary}", r.summary.startsWith("no result submitted: "))
                detail = r.summary
                assertTrue("$ctx: E2 sees failure",
                    bodies.getValue("E2").contains("- task 1 [failed]: no result submitted: "))
            }
        }
        when (fault) {
            Fault.NO_CALL ->
                assertTrue("$ctx: $detail", detail.endsWith("finished without submitting a structured result"))
            Fault.PROVIDER_ERROR -> {
                assertTrue("$ctx: $detail", detail.contains("$label: ") && detail.contains("BOOM_X"))
                // The CLI classifies its errors; the HTTP providers send a bare 5xx without a code.
                if (res is OrchestrationResult.Failed && cell.providerId == "claude") assertNotNull("$ctx: code", res.code)
            }
            Fault.UNKNOWN_TOOL, Fault.FOREIGN_TOOL, Fault.MALFORMED -> {
                // Native calls fail closed; shim text that is not a valid call is retried once, then
                // ends the turn as text. Either way nothing is accepted.
                val ok = detail.contains("$label: invalid_tool_call") ||
                    detail.endsWith("finished without submitting a structured result") ||
                    detail.endsWith("produced no structured result within the turn limit")
                assertTrue("$ctx: $detail", ok)
            }
        }
        if (res is OrchestrationResult.Failed) assertPaired(res.messages, ctx)
    }

    @Test
    fun `every role x cell fails its handoff cleanly on every fault`() {
        val combos = AgentRole.entries.flatMap { r -> cells.flatMap { c -> Fault.entries.map { listOf(r, c, it) } } }
        val failures = mutableListOf<String>()
        for ((r, c, f) in combos) {
            try {
                checkFault(c as Cell, r as AgentRole, f as Fault)
            } catch (e: AssertionError) {
                failures += "$r/$c/$f: ${e.message}"
            }
        }
        if (failures.isNotEmpty()) {
            fail("fault matrix: ${failures.size}/${combos.size} failed:\n" + failures.take(20).joinToString("\n"))
        }
    }
}

package com.adb.stewart

import com.adb.stewart.agents.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SplitRecoveryTest {
    private fun sub(desc: String = "d", file: String = "a.txt", turns: Int? = null) = buildJsonObject {
        put("description", desc); put("output_file", file); turns?.let { put("max_turns", it) }
    }

    private fun args(vararg subs: JsonObject, extra: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("subtasks", JsonArray(subs.toList())); extra()
    }

    private fun parse(a: JsonObject) = SplitRecovery.parseRecovery(a, 5, 60)

    private fun rejected(a: JsonObject, part: String) {
        try { parse(a); fail("expected rejection: $part") } catch (e: ProtocolException) {
            assertTrue(e.message, e.message!!.contains(part))
        }
    }

    @Test fun `valid plan parses`() {
        val p = parse(args(sub("one", "a.txt", 10), sub("two", "b.txt")) {
            put("final_file", "src/out/All.kt"); put("advice", "go")
        })
        assertEquals(listOf(RecoverySubTask("one", "a.txt", 10), RecoverySubTask("two", "b.txt", null)), p.subtasks)
        assertEquals("src/out/All.kt", p.finalFile)
        assertEquals("go", p.advice)
    }

    @Test fun `optional fields absent`() {
        val p = parse(args(sub(file = "a"), sub(file = "b")))
        assertNull(p.finalFile); assertNull(p.advice)
    }

    @Test fun `count bounds`() {
        rejected(args(sub()), "2 to 5")
        rejected(args(*Array(6) { sub(file = "f$it") }), "2 to 5")
        assertEquals(5, parse(args(*Array(5) { sub(file = "f$it") })).subtasks.size)
    }

    @Test fun `blank description`() = rejected(args(sub(" "), sub(file = "b")), "description")

    @Test fun `bad output files`() {
        for (bad in listOf("a/b.txt", "a\\b.txt", "..", "x..y", "/abs", "", " ", "C:foo")) {
            rejected(args(sub(file = bad), sub(file = "ok")), "output_file")
        }
    }

    @Test fun `duplicate output files`() = rejected(args(sub(file = "a"), sub(file = "a")), "duplicate")

    @Test fun `max turns range`() {
        rejected(args(sub(turns = 0), sub(file = "b")), "max_turns")
        rejected(args(sub(turns = 61), sub(file = "b")), "max_turns")
        assertEquals(60, parse(args(sub(turns = 60), sub(file = "b"))).subtasks[0].maxTurns)
    }

    @Test fun `final file rejections`() {
        for (bad in listOf("/etc/x", "\\x", "../x", "a/../../x", "C:\\x")) {
            rejected(args(sub(), sub(file = "b")) { put("final_file", bad) }, "final_file")
        }
        assertEquals("a/b.kt", parse(args(sub(), sub(file = "b")) { put("final_file", "a/b.kt") }).finalFile)
    }

    @Test fun `subtasks not array`() = rejected(buildJsonObject { put("subtasks", "x") }, "array")

    @Test fun `tool spec and execution`() = runBlocking {
        val tool = SplitRecovery.recoveryTool(OrchestratorLimits(maxSubTasks = 3))
        assertEquals(SUBMIT_RECOVERY, tool.spec.name)
        assertTrue(tool.spec.parameters.toString().contains("\"maxItems\":3"))
        assertEquals("accepted", tool.execute(args(sub(file = "a"), sub(file = "b")), null))
        assertEquals(2, tool.accepted!!.subtasks.size)
        try { tool.execute(args(sub()), null); fail() } catch (_: ProtocolException) {}
    }

    private val fault = RecoverableFault(FaultKind.TRUNCATED, null, "cut off")
    private val task = DispatchTask(7, "write big file")

    @Test fun `brief caps actions and omits transcript`() {
        val actions = (1..30).map { RecoveryAction("WriteFile", "f$it.kt") }
        val b = SplitRecovery.buildBrief(task, fault, actions, listOf("a.txt"), OrchestratorLimits(maxActionsInRecoveryBrief = 20), "all done")
        assertTrue(b.contains("TRUNCATED")); assertTrue(b.contains("write big file")); assertTrue(b.contains("all done"))
        assertTrue(b.contains("f20.kt")); assertFalse(b.contains("f21.kt")); assertTrue(b.contains("10 more"))
        assertTrue(b.contains("a.txt")); assertTrue(b.contains(SUBMIT_RECOVERY))
    }

    @Test fun `brief with no actions or scratch`() {
        val b = SplitRecovery.buildBrief(task, fault, emptyList(), emptyList(), OrchestratorLimits())
        assertTrue(b.contains("none")); assertFalse(b.contains("scratch files")); assertFalse(b.contains("definition of done"))
    }

    private val plan = RecoveryPlan(listOf(RecoverySubTask("x", "a"), RecoverySubTask("y", "b")), "out.txt")

    @Test fun `join in subtask order`() =
        assertEquals("AB", SplitRecovery.joinOutputs(plan, mapOf("b" to "B", "a" to "A")))

    @Test fun `join missing output fails`() {
        try { SplitRecovery.joinOutputs(plan, mapOf("a" to "A")); fail() } catch (e: RecoveryAssemblyException) {
            assertTrue(e.message!!.contains("b"))
        }
    }

    @Test fun `merge all done`() {
        val r = SplitRecovery.mergeResults(7, plan, listOf(WorkerResult(7, "done", "s1"), WorkerResult(7, "done", "s2")), 500, 2000)
        assertEquals("done", r.status); assertEquals(7, r.taskId)
        assertTrue(r.summary.contains("s1")); assertTrue(r.summary.contains("file: b")); assertTrue(r.summary.contains("final_file: out.txt"))
    }

    @Test fun `merge any failed or empty is failed`() {
        assertEquals("failed", SplitRecovery.mergeResults(7, plan, listOf(WorkerResult(7, "done", "s"), WorkerResult(7, "failed", "s")), 500, 2000).status)
        assertEquals("failed", SplitRecovery.mergeResults(7, plan, emptyList(), 500, 2000).status)
    }

    @Test fun `merge caps summaries`() {
        val r = SplitRecovery.mergeResults(7, plan, listOf(WorkerResult(7, "done", "x".repeat(900)), WorkerResult(7, "done", "y")), 100, 2000)
        assertFalse(r.summary.contains("x".repeat(101)))
        assertEquals(50, SplitRecovery.mergeResults(7, plan, listOf(WorkerResult(7, "done", "z".repeat(900))), 500, 50).summary.length)
    }
}

package com.adb.stewart

import com.adb.stewart.agents.Plan
import com.adb.stewart.agents.ProtocolException
import com.adb.stewart.agents.WorkerResult
import com.adb.stewart.agents.parsePlan
import com.adb.stewart.agents.parseResult
import com.adb.stewart.agents.parseTasks
import com.adb.stewart.agents.planError
import com.adb.stewart.agents.tasksError
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class OrchestratorParseTest {
    private fun call(@Suppress("UNUSED_PARAMETER") name: String, args: String): JsonObject =
        Json.parseToJsonElement(args).jsonObject

    @Test
    fun parsePlan_missingGoal() {
        val e = assertThrows(ProtocolException::class.java) { parsePlan(call("plan", "{}")) }
        assertEquals("missing 'goal'", e.message)
    }

    @Test
    fun parsePlan_blankGoal() {
        assertThrows(ProtocolException::class.java) { parsePlan(call("plan", """{"goal":"  "}""")) }
    }

    @Test
    fun parsePlan_milestonesNotArray() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":"nope"}"""))
        }
    }

    @Test
    fun parsePlan_milestonesEmpty() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[]}"""))
        }
    }

    @Test
    fun parsePlan_milestoneNotObject() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[1]}"""))
        }
    }

    @Test
    fun parsePlan_milestoneIdMissing() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[{"title":"a"}]}"""))
        }
    }

    @Test
    fun parsePlan_milestoneIdNotInt() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[{"id":"one","title":"a"}]}"""))
        }
    }

    @Test
    fun parsePlan_milestoneTitleMissing() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[{"id":1}]}"""))
        }
    }

    @Test
    fun parsePlan_milestoneTitleBlank() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[{"id":1,"title":" "}]}"""))
        }
    }

    @Test
    fun parsePlan_duplicateMilestoneId() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(
                call(
                    "plan",
                    """{"goal":"g","milestones":[{"id":1,"title":"a"},{"id":1,"title":"b"}]}"""
                )
            )
        }
    }

    @Test
    fun parsePlan_idsOutOfOrder() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(call("plan", """{"goal":"g","milestones":[{"id":2,"title":"a"}]}"""))
        }
    }

    @Test
    fun parsePlan_idsNotStartingAtStartId() {
        assertThrows(ProtocolException::class.java) {
            parsePlan(
                call("plan", """{"goal":"g","milestones":[{"id":1,"title":"a"},{"id":2,"title":"b"}]}"""),
                startId = 2
            )
        }
    }

    @Test
    fun parsePlan_happyPath_defaultsNotes() {
        val plan = parsePlan(
            call(
                "plan",
                """{"goal":"g","milestones":[{"id":3,"title":"a"},{"id":4,"title":"b","notes":"n"}]}"""
            ),
            startId = 3
        )
        assertEquals("g", plan.goal)
        assertEquals(2, plan.milestones.size)
        assertEquals("", plan.milestones[0].notes)
        assertEquals("n", plan.milestones[1].notes)
    }

    @Test
    fun parseTasks_notArray() {
        assertThrows(ProtocolException::class.java) { parseTasks(call("dispatch_tasks", """{"tasks":{}}""")) }
    }

    @Test
    fun parseTasks_taskNotObject() {
        assertThrows(ProtocolException::class.java) { parseTasks(call("dispatch_tasks", """{"tasks":[5]}""")) }
    }

    @Test
    fun parseTasks_taskIdMissing() {
        assertThrows(ProtocolException::class.java) {
            parseTasks(call("dispatch_tasks", """{"tasks":[{"description":"d"}]}"""))
        }
    }

    @Test
    fun parseTasks_taskIdNotInt() {
        assertThrows(ProtocolException::class.java) {
            parseTasks(call("dispatch_tasks", """{"tasks":[{"id":"x","description":"d"}]}"""))
        }
    }

    @Test
    fun parseTasks_taskDescriptionMissing() {
        assertThrows(ProtocolException::class.java) { parseTasks(call("dispatch_tasks", """{"tasks":[{"id":1}]}""")) }
    }

    @Test
    fun parseTasks_taskDescriptionBlank() {
        assertThrows(ProtocolException::class.java) {
            parseTasks(call("dispatch_tasks", """{"tasks":[{"id":1,"description":" "}]}"""))
        }
    }

    @Test
    fun parseTasks_duplicateTaskId() {
        assertThrows(ProtocolException::class.java) {
            parseTasks(
                call(
                    "dispatch_tasks",
                    """{"tasks":[{"id":1,"description":"a"},{"id":1,"description":"b"}]}"""
                )
            )
        }
    }

    @Test
    fun parseTasks_happyPath() {
        val tasks = parseTasks(
            call(
                "dispatch_tasks",
                """{"tasks":[{"id":1,"description":"a"},{"id":2,"description":"b"}]}"""
            )
        )
        assertEquals(listOf(1, 2), tasks.map { it.id })
        assertEquals(listOf("a", "b"), tasks.map { it.description })
    }

    @Test
    fun parseResult_taskIdMissing() {
        assertThrows(ProtocolException::class.java) {
            parseResult(call("complete_milestone", """{"status":"done","summary":"s"}"""), 1)
        }
    }

    @Test
    fun parseResult_taskIdNotInt() {
        assertThrows(ProtocolException::class.java) {
            parseResult(call("complete_milestone", """{"task_id":"x","status":"done","summary":"s"}"""), 1)
        }
    }

    @Test
    fun parseResult_taskIdMismatch() {
        assertThrows(ProtocolException::class.java) {
            parseResult(call("complete_milestone", """{"task_id":2,"status":"done","summary":"s"}"""), 1)
        }
    }

    @Test
    fun parseResult_statusMissing() {
        assertThrows(ProtocolException::class.java) {
            parseResult(call("complete_milestone", """{"task_id":1,"summary":"s"}"""), 1)
        }
    }

    @Test
    fun parseResult_statusInvalid() {
        assertThrows(ProtocolException::class.java) {
            parseResult(call("complete_milestone", """{"task_id":1,"status":"pending","summary":"s"}"""), 1)
        }
    }

    @Test
    fun parseResult_summaryMissing() {
        assertThrows(ProtocolException::class.java) {
            parseResult(call("complete_milestone", """{"task_id":1,"status":"done"}"""), 1)
        }
    }

    @Test
    fun parseResult_happyPath() {
        val done = parseResult(
            call("complete_milestone", """{"task_id":7,"status":"done","summary":"ok"}"""),
            7
        )
        assertEquals(WorkerResult(7, "done", "ok"), done)
        val failed = parseResult(
            call("complete_milestone", """{"task_id":7,"status":"failed","summary":"boom"}"""),
            7
        )
        assertEquals("failed", failed.status)
    }

    @Test
    fun planError_overLimit() {
        val plan = Plan("g", listOf(com.adb.stewart.agents.Milestone(1, "a", "")))
        assertEquals("plan has 1 milestones (max 0)", planError(plan, maxMilestones = 0))
    }

    @Test
    fun planError_withinLimit() {
        val plan = Plan("g", listOf(com.adb.stewart.agents.Milestone(1, "a", "")))
        assertNull(planError(plan, maxMilestones = 5))
    }

    @Test
    fun tasksError_overLimit() {
        val tasks = listOf(
            com.adb.stewart.agents.DispatchTask(1, "a"),
            com.adb.stewart.agents.DispatchTask(2, "b")
        )
        assertEquals("round has 2 tasks (max 1)", tasksError(tasks, maxTasksPerRound = 1))
    }

    @Test
    fun tasksError_withinLimit() {
        val tasks = listOf(com.adb.stewart.agents.DispatchTask(1, "a"))
        assertNull(tasksError(tasks, maxTasksPerRound = 5))
    }

    @Test
    fun parseTasks_filesAndDependsOn() {
        val tasks = parseTasks(
            call(
                "t",
                """{"tasks":[{"id":1,"description":"a","files":["x.kt"]},
                    {"id":2,"description":"b","files":["y.kt","z.kt"],"depends_on":[1]}]}""",
            )
        )
        assertEquals(listOf("x.kt"), tasks[0].files)
        assertEquals(emptyList<Int>(), tasks[0].dependsOn)
        assertEquals(listOf("y.kt", "z.kt"), tasks[1].files)
        assertEquals(listOf(1), tasks[1].dependsOn)
    }

    @Test
    fun parseTasks_absentOrNullOptionalsDefaultToEmpty() {
        val tasks = parseTasks(call("t", """{"tasks":[{"id":1,"description":"a","files":null,"depends_on":null}]}"""))
        assertEquals(emptyList<String>(), tasks[0].files)
        assertEquals(emptyList<Int>(), tasks[0].dependsOn)
    }

    private fun assertRejected(json: String) {
        assertThrows(ProtocolException::class.java) { parseTasks(call("t", json)) }
    }

    @Test
    fun parseTasks_rejectsBadFilesAndDependsOn() {
        assertRejected("""{"tasks":[{"id":1,"description":"a","files":"x.kt"}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a","files":[1]}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a","files":[{"p":"x"}]}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a"},{"id":2,"description":"b","depends_on":1}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a"},{"id":2,"description":"b","depends_on":["1"]}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a"},{"id":2,"description":"b","depends_on":[1.5]}]}""")
    }

    @Test
    fun parseTasks_rejectsForwardSelfAndUnknownDependencies() {
        assertRejected("""{"tasks":[{"id":1,"description":"a","depends_on":[2]},{"id":2,"description":"b"}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a","depends_on":[1]}]}""")
        assertRejected("""{"tasks":[{"id":1,"description":"a"},{"id":2,"description":"b","depends_on":[9]}]}""")
    }
}

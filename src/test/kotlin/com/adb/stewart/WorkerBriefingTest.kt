package com.adb.stewart

import com.adb.stewart.agents.DispatchTask
import com.adb.stewart.agents.Milestone
import com.adb.stewart.agents.WorkerResult
import com.adb.stewart.agents.workerBriefing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkerBriefingTest {
    private val ms = Milestone(2, "build", "notes never shown")

    @Test
    fun `formats goal milestone task files and prior results one per line`() {
        val text = workerBriefing(
            "ship", ms,
            DispatchTask(3, "do it", files = listOf("a.kt", "b.kt"), dependsOn = listOf(1, 2)),
            listOf(WorkerResult(1, "done", "first"), WorkerResult(2, "failed", "line one\n  line two")),
            2000,
        )
        assertEquals(
            "Goal: ship\nMilestone 2: build\nTask 3: do it\nFiles: a.kt, b.kt\n" +
                "Prior #1 done: first\nPrior #2 failed: line one line two",
            text,
        )
    }

    @Test
    fun `omits files and prior lines when empty`() {
        val text = workerBriefing("ship", ms, DispatchTask(1, "do it"), emptyList(), 2000)
        assertEquals("Goal: ship\nMilestone 2: build\nTask 1: do it", text)
        assertFalse(text.contains("Files"))
        assertFalse(text.contains("Prior"))
    }

    @Test
    fun `truncation drops oldest prior results first and keeps the task line`() {
        val prior = (1..3).map { WorkerResult(it, "done", "s".repeat(40) + it) }
        val task = DispatchTask(9, "do it")
        val full = workerBriefing("g", ms, task, prior, 10_000)
        val limit = full.length - 1
        val text = workerBriefing("g", ms, task, prior, limit)
        assertTrue(text.length <= limit)
        assertFalse(text.contains("Prior #1"))
        assertTrue(text.contains("Prior #2") && text.contains("Prior #3"))
        assertTrue(text.contains("Task 9: do it"))
    }

    @Test
    fun `truncation shortens the goal when priors are gone and still keeps the task line`() {
        val task = DispatchTask(4, "do it")
        val text = workerBriefing("g".repeat(500), ms, task, listOf(WorkerResult(1, "done", "x")), 80)
        assertTrue(text.length <= 80)
        assertTrue(text.contains("Task 4: do it"))
        assertFalse(text.contains("Prior"))
        assertTrue(text.contains("…"))
    }

    @Test
    fun `hard limit smaller than the fixed lines still bounds the text`() {
        val text = workerBriefing("g", ms, DispatchTask(1, "d".repeat(300)), emptyList(), 50)
        assertTrue(text.length <= 51)
    }
}

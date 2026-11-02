package com.aijb.assistant

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.chat.ActivityFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityFormatTest {
    @Test fun noRole() = assertEquals("Working…", ActivityFormat.label(null, null, null))
    @Test fun roleOnly() = assertEquals("Planner", ActivityFormat.label(AgentRole.PLANNER, null, null))
    @Test fun roleWithTool() =
        assertEquals("Worker · RunTerminal", ActivityFormat.label(AgentRole.WORKER, "task t1: run git", "RunTerminal"))
    @Test fun roleWithContext() =
        assertEquals("Worker · task t1", ActivityFormat.label(AgentRole.WORKER, "task t1", null))
    @Test fun longContextTruncated() {
        val s = ActivityFormat.label(AgentRole.EXECUTOR, "x".repeat(200), null)
        assertTrue(s.length <= "Executor · ".length + 40)
    }
    @Test fun routeSuffixDropped() =
        assertEquals("Worker · task t1", ActivityFormat.label(AgentRole.WORKER, "task t1 → ollama/qwen", null))

    // negative / edge cases
    @Test fun blankContextIgnored() =
        assertEquals("Planner", ActivityFormat.label(AgentRole.PLANNER, "   ", null))
    @Test fun emptyContextIgnored() =
        assertEquals("Planner", ActivityFormat.label(AgentRole.PLANNER, "", null))
    @Test fun toolIgnoredWithoutRole() =
        assertEquals("Working…", ActivityFormat.label(null, "task t1", "RunTerminal"))
    @Test fun colonOnlyContextFallsBackToRole() =
        assertEquals("Executor", ActivityFormat.label(AgentRole.EXECUTOR, ": detail", null))
}

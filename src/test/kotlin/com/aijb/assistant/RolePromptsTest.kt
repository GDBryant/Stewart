package com.aijb.assistant

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.RolePrompts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RolePromptsTest {

    @Test
    fun `each role is shared plus its text`() {
        assertEquals(RolePrompts.SHARED + " " + RolePrompts.PLANNER,
            RolePrompts.forRole(AgentRole.PLANNER))
        assertEquals(RolePrompts.SHARED + " " + RolePrompts.EXECUTOR,
            RolePrompts.forRole(AgentRole.EXECUTOR))
        assertEquals(RolePrompts.SHARED + " " + RolePrompts.WORKER,
            RolePrompts.forRole(AgentRole.WORKER))
    }

    @Test
    fun `role texts are distinct`() {
        assertNotEquals(RolePrompts.forRole(AgentRole.PLANNER), RolePrompts.forRole(AgentRole.EXECUTOR))
        assertNotEquals(RolePrompts.forRole(AgentRole.EXECUTOR), RolePrompts.forRole(AgentRole.WORKER))
        assertNotEquals(RolePrompts.forRole(AgentRole.PLANNER), RolePrompts.forRole(AgentRole.WORKER))
    }

    @Test
    fun `every role tells the model not to repeat tool output`() {
        for (role in AgentRole.values()) {
            assertTrue(RolePrompts.forRole(role).contains("Tool output is already shown to the user; do not repeat it."))
        }
        assertFalse(RolePrompts.PLANNER.contains("do not repeat it"))
    }
}

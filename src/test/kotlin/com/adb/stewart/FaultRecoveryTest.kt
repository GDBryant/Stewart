package com.adb.stewart

import com.adb.stewart.agents.AgentRole
import com.adb.stewart.agents.FaultKind
import com.adb.stewart.agents.LevelRun
import com.adb.stewart.agents.LevelStatus
import com.adb.stewart.agents.classify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FaultRecoveryTest {
    private fun run(status: LevelStatus) = LevelRun(emptyList(), null, status, role = AgentRole.EXECUTOR)

    @Test
    fun truncated_code() {
        val f = classify(run(LevelStatus.Failed("cut", "truncated")))!!
        assertEquals(FaultKind.TRUNCATED, f.kind)
        assertEquals(AgentRole.EXECUTOR, f.role)
        assertEquals("cut", f.message)
    }

    @Test
    fun incomplete_stream_code() {
        assertEquals(FaultKind.INCOMPLETE_STREAM, classify(run(LevelStatus.Failed("x", "incomplete_stream")))!!.kind)
    }

    @Test
    fun turn_limit_status() {
        assertEquals(FaultKind.TURN_LIMIT, classify(run(LevelStatus.TurnLimit))!!.kind)
    }

    @Test
    fun everything_else_is_null() {
        assertNull(classify(run(LevelStatus.Completed)))
        assertNull(classify(run(LevelStatus.Failed("x", null))))
        for (code in listOf("rate_limit", "protocol_error", "context_limit", "empty_turn")) {
            assertNull(code, classify(run(LevelStatus.Failed("x", code))))
        }
    }
}

package com.adb.stewart

import com.adb.stewart.agents.AgentRole
import com.adb.stewart.agents.OrchestratorLimits
import com.adb.stewart.settings.AijbSettings
import com.adb.stewart.settings.EffortLevel
import com.adb.stewart.settings.EffortPresets
import com.adb.stewart.settings.forRole
import com.adb.stewart.tools.LoopLimits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.seconds

class EffortLevelTest {

    @Test
    fun `medium reproduces the pre-existing limits`() {
        val base = OrchestratorLimits()
        val medium = EffortPresets.orchestratorLimits(EffortLevel.MEDIUM)
        assertEquals(8, medium.maxMilestones)
        assertEquals(3, medium.maxTaskRounds)
        assertEquals(2, medium.maxReplans)
        assertEquals(15, medium.maxLevelModelTurns)
        assertEquals(3, medium.maxQuestions)
        assertEquals(base.maxTasksPerRound, medium.maxTasksPerRound)
        assertEquals(base.toolTimeout, medium.toolTimeout)
        assertEquals(base.maxHandoffChars, medium.maxHandoffChars)
        assertEquals(25, EffortPresets.loopLimits(EffortLevel.MEDIUM, LoopLimits()).maxModelTurns)
    }

    @Test
    fun `presets are monotonic across every bound`() {
        val levels = EffortLevel.entries
        val budgets = levels.map { EffortPresets.budget(it) }
        budgets.zipWithNext { low, high ->
            assertTrue(low.maxMilestones < high.maxMilestones)
            assertTrue(low.maxTaskRounds < high.maxTaskRounds)
            assertTrue(low.maxReplans < high.maxReplans)
            assertTrue(low.maxLevelModelTurns < high.maxLevelModelTurns)
            assertTrue(low.maxQuestions < high.maxQuestions)
            assertTrue(low.maxModelTurns < high.maxModelTurns)
        }
    }

    @Test
    fun `low allows no planner questions and no replans`() {
        val low = EffortPresets.orchestratorLimits(EffortLevel.LOW)
        assertEquals(0, low.maxQuestions)
        assertEquals(0, low.maxReplans)
    }

    @Test
    fun `orchestrator limits keep the fixed fields of the base`() {
        val base = OrchestratorLimits(maxTasksPerRound = 4, toolTimeout = 5.seconds, maxHandoffChars = 10)
        val max = EffortPresets.orchestratorLimits(EffortLevel.MAX, base)
        assertEquals(4, max.maxTasksPerRound)
        assertEquals(5.seconds, max.toolTimeout)
        assertEquals(10, max.maxHandoffChars)
        assertEquals(16, max.maxMilestones)
    }

    @Test
    fun `loop limits keep compaction and timeout but scale turns`() {
        val base = LoopLimits(toolTimeout = 120.seconds, compactAtTokens = 80000)
        val high = EffortPresets.loopLimits(EffortLevel.HIGH, base)
        assertEquals(40, high.maxModelTurns)
        assertEquals(120.seconds, high.toolTimeout)
        assertEquals(80000, high.compactAtTokens)
    }

    @Test
    fun `parse accepts any casing and rejects unknown values`() {
        assertEquals(EffortLevel.LOW, EffortLevel.parse("low"))
        assertEquals(EffortLevel.MAX, EffortLevel.parse(" Max "))
        assertEquals(EffortLevel.MEDIUM, EffortLevel.parse("medium"))
        assertNull(EffortLevel.parse("turbo"))
        assertNull(EffortLevel.parse(""))
        assertNull(EffortLevel.parse(null))
    }

    @Test
    fun `labels are lowercase names`() {
        assertEquals("low", EffortLevel.LOW.label)
        assertEquals("max", EffortLevel.MAX.label)
    }

    @Test
    fun `role override only wins when set`() {
        val overrides = mapOf(AgentRole.WORKER.name to "MAX")
        assertEquals(EffortLevel.MAX, EffortLevel.LOW.forRole(AgentRole.WORKER, overrides))
        assertEquals(EffortLevel.LOW, EffortLevel.LOW.forRole(AgentRole.PLANNER, overrides))
        assertEquals(EffortLevel.LOW, EffortLevel.LOW.forRole(AgentRole.WORKER, emptyMap()))
        assertEquals(EffortLevel.LOW, EffortLevel.LOW.forRole(AgentRole.WORKER, mapOf("WORKER" to "bogus")))
    }

    @Test
    fun `settings default to medium and ignore role overrides in single mode`() {
        val settings = AijbSettings()
        settings.loadState(AijbSettings.State())
        assertEquals(EffortLevel.MEDIUM, settings.effortLevel)
        settings.state.roleEffort = mutableMapOf(AgentRole.PLANNER.name to "MAX")
        assertEquals(EffortLevel.MEDIUM, settings.effortFor(AgentRole.PLANNER))
        settings.state.multiModel = true
        assertEquals(EffortLevel.MAX, settings.effortFor(AgentRole.PLANNER))
        assertEquals(EffortLevel.MEDIUM, settings.effortFor(AgentRole.EXECUTOR))
    }

    @Test
    fun `settings fall back to medium for an unknown stored value`() {
        val settings = AijbSettings()
        settings.loadState(AijbSettings.State().also { it.effort = "turbo" })
        assertEquals(EffortLevel.MEDIUM, settings.effortLevel)
        settings.state.effort = "high"
        assertEquals(EffortLevel.HIGH, settings.effortLevel)
    }
}

package com.adb.stewart.settings

import com.adb.stewart.agents.AgentRole
import com.adb.stewart.agents.OrchestratorLimits
import com.adb.stewart.tools.LoopLimits

enum class EffortLevel {
    LOW, MEDIUM, HIGH, MAX;

    val label: String get() = name.lowercase()

    companion object {
        val DEFAULT: EffortLevel = MEDIUM

        fun parse(raw: String?): EffortLevel? {
            val trimmed = raw?.trim() ?: return null
            return entries.firstOrNull { it.name.equals(trimmed, ignoreCase = true) }
        }
    }
}

data class EffortBudget(
    val maxMilestones: Int,
    val maxTaskRounds: Int,
    val maxReplans: Int,
    val maxLevelModelTurns: Int,
    val maxQuestions: Int,
    val maxModelTurns: Int,
)

object EffortPresets {

    fun budget(level: EffortLevel): EffortBudget = when (level) {
        EffortLevel.LOW -> EffortBudget(3, 1, 0, 6, 0, 8)
        EffortLevel.MEDIUM -> EffortBudget(8, 3, 2, 15, 3, 25)
        EffortLevel.HIGH -> EffortBudget(12, 4, 3, 22, 4, 40)
        EffortLevel.MAX -> EffortBudget(16, 6, 5, 30, 6, 60)
    }

    fun orchestratorLimits(level: EffortLevel, base: OrchestratorLimits = OrchestratorLimits()): OrchestratorLimits {
        val b = budget(level)
        return base.copy(
            maxMilestones = b.maxMilestones,
            maxTaskRounds = b.maxTaskRounds,
            maxReplans = b.maxReplans,
            maxLevelModelTurns = b.maxLevelModelTurns,
            maxQuestions = b.maxQuestions,
        )
    }

    fun loopLimits(level: EffortLevel, base: LoopLimits): LoopLimits =
        base.copy(maxModelTurns = budget(level).maxModelTurns)
}

fun EffortLevel.forRole(role: AgentRole, overrides: Map<String, String>): EffortLevel =
    EffortLevel.parse(overrides[role.name]) ?: this

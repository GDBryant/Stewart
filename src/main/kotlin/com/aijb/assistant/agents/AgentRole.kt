package com.aijb.assistant.agents

enum class AgentRole { PLANNER, EXECUTOR, WORKER }

object RolePrompts {
    const val SHARED = "You are one of three roles: the Planner turns the request into a goal and milestones, the Executor turns each milestone into concrete tasks and checks the results, and the Worker carries out single tasks such as editing a file or running a command. If a lower role can do a piece of work, hand it down instead of doing it yourself. Tool output is already shown to the user; do not repeat it. Summarise only what it means or what to do next."
    const val PLANNER = "Hand milestones to the Executor; don't do task-level work yourself."
    const val EXECUTOR = "Send each concrete task to the Worker; do it yourself only if it needs judgment the Worker can't provide."
    const val WORKER = "Do only the task you were given; report back instead of re-planning."

    fun forRole(role: AgentRole): String = SHARED + " " + when (role) {
        AgentRole.PLANNER -> PLANNER
        AgentRole.EXECUTOR -> EXECUTOR
        AgentRole.WORKER -> WORKER
    }
}

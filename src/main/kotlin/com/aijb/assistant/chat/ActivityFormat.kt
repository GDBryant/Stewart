package com.aijb.assistant.chat

import com.aijb.assistant.agents.AgentRole

object ActivityFormat {
    private const val MAX = 40

    fun label(role: AgentRole?, context: String?, tool: String?): String {
        if (role == null) return "Working…"
        val name = role.name.lowercase().replaceFirstChar { it.uppercase() }
        val ctx = context?.substringBefore(" → ")?.substringBefore(":")?.trim()?.take(MAX)?.ifEmpty { null }
        // tool name wins over context while a tool runs
        val detail = tool ?: ctx
        return if (detail == null) name else "$name · $detail"
    }
}

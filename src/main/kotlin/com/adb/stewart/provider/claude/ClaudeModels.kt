package com.adb.stewart.provider.claude

object ClaudeModels {
    private val FAMILY = Regex("^(claude\\s+)?(opus|sonnet|haiku)\\b.*", RegexOption.IGNORE_CASE)
    private val WHITESPACE = Regex("\\s+")

    fun normalize(raw: String): String {
        val s = raw.trim()
        if (!s.any { it.isWhitespace() }) return s
        FAMILY.matchEntire(s)?.let { return it.groupValues[2].lowercase() }
        return s.lowercase().replace(WHITESPACE, "-")
    }
}

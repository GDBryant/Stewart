package com.adb.stewart.chat

/** Shell-style Up/Down recall over earlier prompts (entries oldest to newest). */
class PromptHistory {
    private var entries = emptyList<String>()
    private var idx = -1

    val browsing: Boolean get() = idx >= 0

    fun reset(entries: List<String>) {
        this.entries = entries
        idx = -1
    }

    /** Next older prompt; null when there is none or already at the oldest (stay put). */
    fun older(): String? {
        if (entries.isEmpty()) return null
        val next = if (idx < 0) entries.lastIndex else idx - 1
        if (next < 0) return null
        idx = next
        return entries[idx]
    }

    /** Next newer prompt; "" past the newest (ends browsing); null when not browsing. */
    fun newer(): String? {
        if (idx < 0) return null
        if (idx == entries.lastIndex) {
            idx = -1
            return ""
        }
        idx++
        return entries[idx]
    }

    fun stopBrowsing() {
        idx = -1
    }
}

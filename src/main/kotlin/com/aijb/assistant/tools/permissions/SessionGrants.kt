package com.aijb.assistant.tools.permissions

/**
 * Chat-scoped approvals ("allow for this chat"); lives only in memory on `ChatSession` and is
 * cleared with the conversation. Reads may run off the EDT, so every method is synchronised.
 */
class SessionGrants {
    private val categories = mutableSetOf<ApprovalCategory>()
    private val programs = mutableSetOf<String>()
    private var autoApproved = 0

    @Synchronized
    fun grant(category: ApprovalCategory) {
        categories += category
    }

    @Synchronized
    fun grant(programs: Collection<String>) {
        this.programs += programs
    }

    @Synchronized
    fun revoke(category: ApprovalCategory) {
        categories -= category
    }

    @Synchronized
    fun revokeProgram(program: String) {
        programs -= program
    }

    @Synchronized
    fun clear() {
        categories.clear()
        programs.clear()
        autoApproved = 0
    }

    @Synchronized
    fun recordAutoApproved() {
        autoApproved++
    }

    @Synchronized
    fun autoApprovedCount(): Int = autoApproved

    @Synchronized
    fun covers(category: ApprovalCategory): Boolean = category in categories

    @Synchronized
    fun coversPrograms(needed: Collection<String>): Boolean = programs.containsAll(needed)

    @Synchronized
    fun categories(): Set<ApprovalCategory> = categories.toSet()

    @Synchronized
    fun programs(): Set<String> = programs.toSet()
}

package com.aijb.assistant

import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.tools.permissions.ApprovalCategory
import com.aijb.assistant.tools.permissions.SessionGrants
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class SessionGrantsTest : BasePlatformTestCase() {

    fun `test grants cover categories and programs`() {
        val grants = SessionGrants()
        assertFalse(grants.covers(ApprovalCategory.EDITS))
        assertFalse(grants.coversPrograms(listOf("git")))
        grants.grant(ApprovalCategory.EDITS)
        grants.grant(listOf("git", "grep"))
        assertTrue(grants.covers(ApprovalCategory.EDITS))
        assertFalse(grants.covers(ApprovalCategory.COMMANDS))
        assertTrue(grants.coversPrograms(listOf("git")))
        assertTrue(grants.coversPrograms(listOf("git", "grep")))
        assertFalse(grants.coversPrograms(listOf("git", "rm")))
        assertEquals(setOf(ApprovalCategory.EDITS), grants.categories())
        assertEquals(setOf("git", "grep"), grants.programs())
    }

    fun `test revoke removes single entries`() {
        val grants = SessionGrants()
        grants.grant(ApprovalCategory.EDITS)
        grants.grant(ApprovalCategory.COMMANDS)
        grants.grant(listOf("git", "grep"))
        grants.revoke(ApprovalCategory.EDITS)
        grants.revokeProgram("git")
        assertFalse(grants.covers(ApprovalCategory.EDITS))
        assertTrue(grants.covers(ApprovalCategory.COMMANDS))
        assertEquals(setOf("grep"), grants.programs())
    }

    fun `test clear removes everything`() {
        val grants = SessionGrants()
        grants.grant(ApprovalCategory.EDITS)
        grants.grant(listOf("git"))
        grants.clear()
        assertTrue(grants.categories().isEmpty())
        assertTrue(grants.programs().isEmpty())
        assertFalse(grants.covers(ApprovalCategory.EDITS))
        assertFalse(grants.coversPrograms(listOf("git")))
    }

    fun `test clear history clears the session grants`() {
        val session = ChatSession.getInstance(project)
        session.sessionGrants.grant(ApprovalCategory.EDITS)
        assertTrue(session.sessionGrants.covers(ApprovalCategory.EDITS))
        session.clearHistory()
        assertFalse(session.sessionGrants.covers(ApprovalCategory.EDITS))
    }

    fun `test always grants are separate from session grants`() {
        val session = ChatSession.getInstance(project)
        session.sessionGrants.grant(listOf("git"))
        session.clearHistory()
        assertTrue(session.sessionGrants.programs().isEmpty())
    }
}

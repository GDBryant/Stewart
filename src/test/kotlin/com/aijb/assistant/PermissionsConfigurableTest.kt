package com.aijb.assistant

import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.settings.PermissionsConfigurable
import com.aijb.assistant.tools.permissions.ApprovalCategory
import com.aijb.assistant.tools.permissions.ProjectPermissions
import com.intellij.openapi.options.ConfigurationException
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class PermissionsConfigurableTest : BasePlatformTestCase() {

    private lateinit var configurable: PermissionsConfigurable
    private val permissions get() = ProjectPermissions.getInstance()

    override fun setUp() {
        super.setUp()
        permissions.resetForTest()
        permissions.forProject(project)
        configurable = PermissionsConfigurable(project)
        configurable.createPanel()
        configurable.reset()
    }

    override fun tearDown() {
        try {
            permissions.resetForTest()
        } finally {
            super.tearDown()
        }
    }

    fun `test tick round trips`() {
        assertFalse(configurable.tickBoxes.getValue(ApprovalCategory.EDITS).isSelected)
        configurable.tickBoxes.getValue(ApprovalCategory.EDITS).isSelected = true
        assertTrue(configurable.isModified)
        configurable.apply()
        assertTrue(permissions.forProject(project).covers(ApprovalCategory.EDITS))
        configurable.reset()
        assertTrue(configurable.tickBoxes.getValue(ApprovalCategory.EDITS).isSelected)
        assertFalse(configurable.isModified)
    }

    fun `test program list round trips`() {
        configurable.programField.text = "git"
        configurable.addProgram()
        configurable.programField.text = "C:\\Program Files\\tool\\t.exe"
        configurable.addProgram()
        assertTrue(configurable.isModified)
        configurable.apply()
        assertEquals(
            setOf("git", "C:\\Program Files\\tool\\t.exe"),
            permissions.forProject(project).programs,
        )
        configurable.programsModel.removeElement("git")
        configurable.apply()
        assertEquals(setOf("C:\\Program Files\\tool\\t.exe"), permissions.forProject(project).programs)
    }

    fun `test blank program is rejected`() {
        val errors = mutableListOf<String>()
        configurable.programError = { errors += it }
        configurable.programField.text = "   "
        configurable.addProgram()
        assertEquals(listOf("Program cannot be blank"), errors)
        assertEquals(0, configurable.programsModel.size)
    }

    fun `test stored project path is shown`() {
        permissions.addProgram(project, "git")
        configurable.reset()
        assertEquals(project.basePath.orEmpty(), configurable.pathLabel.text)
    }

    fun `test chat grants are listed and cleared`() {
        val session = ChatSession.getInstance(project)
        session.sessionGrants.grant(ApprovalCategory.EDITS)
        session.sessionGrants.grant(listOf("git"))
        configurable.reset()
        assertTrue(configurable.chatGrantsArea.text.contains("edits"))
        assertTrue(configurable.chatGrantsArea.text.contains("git"))
        configurable.clearChatButton.actionListeners.forEach { it.actionPerformed(null) }
        assertEquals("(none)", configurable.chatGrantsArea.text)
        assertFalse(session.sessionGrants.covers(ApprovalCategory.EDITS))
    }

    fun `test reset all clears every project after confirmation`() {
        permissions.setTick(project, ApprovalCategory.COMMANDS, true)
        permissions.addProgram(project, "git")
        configurable.reset()
        configurable.confirmReset = { false }
        configurable.resetAllButton.actionListeners.forEach { it.actionPerformed(null) }
        assertTrue(permissions.forProject(project).covers(ApprovalCategory.COMMANDS))

        configurable.confirmReset = { true }
        configurable.resetAllButton.actionListeners.forEach { it.actionPerformed(null) }
        assertTrue(permissions.forProject(project).programs.isEmpty())
        assertFalse(permissions.forProject(project).covers(ApprovalCategory.COMMANDS))
    }
}

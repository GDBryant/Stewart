package com.aijb.assistant

import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.ui.RolesPanel
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class RolesPanelTest : BasePlatformTestCase() {

    private val models = listOf(
        ModelInfo(ModelRef("ollama", "m1"), "m1"),
        ModelInfo(ModelRef("aif", "m2"), "m2"),
    )

    override fun setUp() {
        super.setUp()
        AijbSettings.getInstance().loadState(AijbSettings.State())
    }

    override fun tearDown() {
        try {
            AijbSettings.getInstance().loadState(AijbSettings.State())
        } finally {
            super.tearDown()
        }
    }

    fun `test reset reflects settings`() {
        val s = AijbSettings.getInstance().state
        s.multiModel = true
        s.plannerModel = "ollama/m1"
        val panel = RolesPanel(models, AijbSettings.getInstance())
        assertTrue(panel.multiModelCheck.isSelected)
        assertTrue(panel.plannerCombo.isEnabled)
        assertEquals(ModelRef("ollama", "m1"), (panel.plannerCombo.selectedItem as RolesPanel.RoleItem).ref)
        assertNull((panel.executorCombo.selectedItem as RolesPanel.RoleItem).ref)
    }

    fun `test apply writes back`() {
        val panel = RolesPanel(models, AijbSettings.getInstance())
        panel.multiModelCheck.isSelected = true
        panel.executorCombo.selectedIndex = 2
        panel.workerCombo.selectedIndex = 1
        panel.apply()
        val s = AijbSettings.getInstance().state
        assertTrue(s.multiModel)
        assertEquals("aif/m2", s.executorModel)
        assertEquals("ollama/m1", s.workerModel)
        assertNull(s.plannerModel)
    }

    fun `test combos disabled when multi model off`() {
        val panel = RolesPanel(models, AijbSettings.getInstance())
        assertFalse(panel.plannerCombo.isEnabled)
        assertFalse(panel.executorCombo.isEnabled)
        assertFalse(panel.workerCombo.isEnabled)
        panel.multiModelCheck.isSelected = true
        panel.multiModelCheck.actionListeners.forEach {
            it.actionPerformed(java.awt.event.ActionEvent(panel.multiModelCheck, 0, ""))
        }
        assertTrue(panel.plannerCombo.isEnabled)
    }

    fun `test toggling multi on seeds unset roles from the chat model and notifies`() {
        val s = AijbSettings.getInstance().state
        s.chatModel = "ollama/m1"
        s.workerModel = "aif/m2"
        val seen = mutableListOf<Boolean>()
        val panel = RolesPanel(models, AijbSettings.getInstance()) { seen += it }
        panel.multiModelCheck.isSelected = true
        panel.onMultiModelToggled()
        assertTrue(s.multiModel)
        assertEquals("ollama/m1", s.plannerModel)
        assertEquals("ollama/m1", s.executorModel)
        assertEquals("aif/m2", s.workerModel)
        assertEquals(ModelRef("ollama", "m1"), (panel.plannerCombo.selectedItem as RolesPanel.RoleItem).ref)
        assertEquals(listOf(true), seen)
        panel.multiModelCheck.isSelected = false
        panel.onMultiModelToggled()
        assertFalse(s.multiModel)
        assertFalse(panel.plannerCombo.isEnabled)
        assertEquals("ollama/m1", s.plannerModel)
        assertEquals(listOf(true, false), seen)
    }

    fun `test toggling multi on without a chat model leaves roles unset`() {
        val s = AijbSettings.getInstance().state
        val panel = RolesPanel(models, AijbSettings.getInstance())
        panel.multiModelCheck.isSelected = true
        panel.onMultiModelToggled()
        assertNull(s.plannerModel)
        assertNull(s.executorModel)
        assertNull(s.workerModel)
    }

    fun `test unknown stored ref preserved`() {
        val s = AijbSettings.getInstance().state
        s.multiModel = true
        s.workerModel = "gone/x9"
        val panel = RolesPanel(models, AijbSettings.getInstance())
        val item = panel.workerCombo.selectedItem as RolesPanel.RoleItem
        assertEquals(ModelRef("gone", "x9"), item.ref)
        panel.apply()
        assertEquals("gone/x9", AijbSettings.getInstance().state.workerModel)
    }

    fun `test first combo item is chat selection`() {
        val panel = RolesPanel(models, AijbSettings.getInstance())
        assertNull(panel.plannerCombo.getItemAt(0).ref)
        assertEquals("(chat selection)", panel.plannerCombo.getItemAt(0).label)
        assertEquals(3, panel.plannerCombo.itemCount)
    }
}

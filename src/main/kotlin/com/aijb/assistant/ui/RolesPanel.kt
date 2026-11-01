package com.aijb.assistant.ui

import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.settings.AijbSettings
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.util.ui.JBUI
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JPanel

class RolesPanel(
    private val models: List<ModelInfo>,
    private val settings: AijbSettings,
    private val onMultiModelChanged: (Boolean) -> Unit = {},
) : JPanel(GridBagLayout()) {

    data class RoleItem(val ref: ModelRef?, val label: String) {
        override fun toString() = label
    }

    internal val multiModelCheck = JCheckBox("Multi-model mode")
    internal val plannerCombo = JComboBox<RoleItem>()
    internal val executorCombo = JComboBox<RoleItem>()
    internal val workerCombo = JComboBox<RoleItem>()

    init {
        border = JBUI.Borders.empty(8)
        val c = GridBagConstraints().apply {
            gridx = 0; gridy = 0; anchor = GridBagConstraints.WEST
        }
        c.gridwidth = 2
        add(multiModelCheck, c)
        c.gridwidth = 1
        listOf(
            "Planner:" to plannerCombo,
            "Executor:" to executorCombo,
            "Worker:" to workerCombo,
        ).forEachIndexed { i, (label, combo) ->
            c.gridx = 0; c.gridy = i + 1
            add(JLabel(label), c)
            c.gridx = 1
            add(combo, c)
        }
        plannerCombo.renderer = itemRenderer()
        executorCombo.renderer = itemRenderer()
        workerCombo.renderer = itemRenderer()
        multiModelCheck.addActionListener { onMultiModelToggled() }
        reset()
    }

    /** Enabling multi-model seeds unset roles from the single picker and re-enables the role combos. */
    internal fun onMultiModelToggled() {
        apply()
        val on = multiModelCheck.isSelected
        if (on) settings.seedRoleModels()
        reset()
        onMultiModelChanged(on)
    }

    private fun itemRenderer() = object : SimpleListCellRenderer<RoleItem>() {
        override fun customize(
            list: javax.swing.JList<out RoleItem>,
            value: RoleItem?,
            index: Int,
            selected: Boolean,
            hasFocus: Boolean,
        ) {
            text = value?.label ?: ""
        }
    }

    private fun labelFor(ref: ModelRef): String {
        val known = models.firstOrNull { it.ref == ref }
        return known?.let { "${it.displayName} · ${ref.providerId}" } ?: ref.encode()
    }

    private fun populate(combo: JComboBox<RoleItem>, stored: String?) {
        val storedRef = ModelRef.decode(stored)
        combo.removeAllItems()
        combo.addItem(RoleItem(null, "(chat selection)"))
        models.forEach { combo.addItem(RoleItem(it.ref, labelFor(it.ref))) }
        if (storedRef != null && models.none { it.ref == storedRef }) {
            combo.addItem(RoleItem(storedRef, labelFor(storedRef)))
        }
        val idx = (0 until combo.itemCount).firstOrNull {
            combo.getItemAt(it).ref == storedRef
        } ?: 0
        combo.selectedIndex = idx
    }

    fun reset() {
        val s = settings.state
        multiModelCheck.isSelected = s.multiModel
        populate(plannerCombo, s.plannerModel)
        populate(executorCombo, s.executorModel)
        populate(workerCombo, s.workerModel)
        updateEnabled()
    }

    fun apply() {
        val s = settings.state
        s.multiModel = multiModelCheck.isSelected
        s.plannerModel = (plannerCombo.selectedItem as? RoleItem)?.ref?.encode()
        s.executorModel = (executorCombo.selectedItem as? RoleItem)?.ref?.encode()
        s.workerModel = (workerCombo.selectedItem as? RoleItem)?.ref?.encode()
    }

    private fun updateEnabled() {
        val on = multiModelCheck.isSelected
        plannerCombo.isEnabled = on
        executorCombo.isEnabled = on
        workerCombo.isEnabled = on
    }
}

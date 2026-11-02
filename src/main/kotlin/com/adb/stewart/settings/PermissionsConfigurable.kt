package com.adb.stewart.settings

import com.adb.stewart.chat.ChatSession
import com.adb.stewart.tools.permissions.ApprovalCategory
import com.adb.stewart.tools.permissions.ProjectPermissions
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.panel
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JLabel
import javax.swing.JList

/**
 * Project-level bypass settings: category ticks and always-granted programs for this project, a
 * read-only view of the chat's session grants and the global reset. Registered as a top-level
 * project page; it cannot be a child of the application-level [AijbConfigurable].
 */
class PermissionsConfigurable(
    private val project: Project,
) : BoundConfigurable("AIJB Assistant") {

    private val permissions get() = ProjectPermissions.getInstance()
    private val session get() = ChatSession.getInstance(project)

    internal val tickBoxes = linkedMapOf<ApprovalCategory, JCheckBox>()
    internal val programsModel = DefaultListModel<String>()
    internal lateinit var programsList: JList<String>
    internal lateinit var programField: JBTextField
    internal lateinit var addButton: JButton
    internal lateinit var removeButton: JButton
    internal lateinit var pathLabel: JLabel
    internal lateinit var chatGrantsArea: javax.swing.JTextArea
    internal lateinit var clearChatButton: JButton
    internal lateinit var resetAllButton: JButton

    /** Confirmation for "Reset all projects"; replaced in tests. */
    internal var confirmReset: () -> Boolean = {
        Messages.showYesNoDialog(
            project,
            "Remove every project's bypass ticks and program grants? Chat grants are kept.",
            "AIJB Permissions",
            "Reset all",
            "Cancel",
            null,
        ) == Messages.YES
    }

    override fun createPanel(): DialogPanel = panel {
        group("Bypass approvals in this project") {
            for (category in ApprovalCategory.entries) {
                row {
                    tickBoxes[category] =
                        checkBox("Always allow ${category.name.lowercase()}").component
                }
            }
        }
        group("Always-allowed programs (every argument list, any directory)") {
            row {
                programField = textField().component
                addButton = JButton("Add").also { button ->
                    button.addActionListener { addProgram() }
                    cell(button)
                }
                removeButton = JButton("Remove").also { button ->
                    button.addActionListener {
                        programsList.selectedValuesList.forEach { programsModel.removeElement(it) }
                    }
                    cell(button)
                }
            }
            row {
                programsList = JList(programsModel)
                cell(JBScrollPane(programsList))
            }
        }
        group("Status") {
            row("Stored project path:") { pathLabel = label("").component }
            row("This chat's grants:") {
                chatGrantsArea = javax.swing.JTextArea(3, 30).also {
                    it.isEditable = false
                    cell(JBScrollPane(it))
                }
            }
            row {
                clearChatButton = JButton("Clear chat grants").also { button ->
                    button.addActionListener {
                        session.sessionGrants.clear()
                        refreshChatGrants()
                    }
                    cell(button)
                }
                resetAllButton = JButton("Reset all projects").also { button ->
                    button.addActionListener {
                        if (confirmReset()) {
                            permissions.resetAll()
                            reset()
                        }
                    }
                    cell(button)
                }
            }
        }
    }

    /** Shown instead of throwing: a listener exception becomes an IDE fatal error. */
    internal var programError: (String) -> Unit = {
        Messages.showErrorDialog(project, it, "AIJB Permissions")
    }

    internal fun addProgram() {
        val program = programField.text.trim()
        if (program.isEmpty()) {
            programError("Program cannot be blank")
            return
        }
        if (!(0 until programsModel.size).any { programsModel.get(it) == program }) {
            programsModel.addElement(program)
        }
        programField.text = ""
    }

    private fun programEntries(): List<String> = (0 until programsModel.size).map { programsModel.get(it) }

    private fun currentPrograms(): Set<String> = permissions.forProject(project).programs

    private fun refreshChatGrants() {
        val g = session.sessionGrants
        val cats = g.categories().joinToString(", ") { it.name.lowercase() }
        val progs = g.programs().sorted().joinToString(", ")
        chatGrantsArea.text = buildList {
            if (cats.isNotEmpty()) add("categories: $cats")
            if (progs.isNotEmpty()) add("programs: $progs")
        }.joinToString("\n").ifEmpty { "(none)" }
    }

    override fun isModified(): Boolean {
        if (tickBoxes.isEmpty() || !::programsList.isInitialized) return false
        val snap = permissions.forProject(project)
        return tickBoxes.any { (cat, box) -> box.isSelected != snap.covers(cat) } ||
            programEntries().toSet() != snap.programs
    }

    override fun reset() {
        val snap = permissions.forProject(project)
        tickBoxes.forEach { (cat, box) -> box.isSelected = snap.covers(cat) }
        programsModel.clear()
        snap.programs.sorted().forEach { programsModel.addElement(it) }
        pathLabel.text = permissions.pathFor(project).orEmpty().ifEmpty { "(unknown)" }
        if (::chatGrantsArea.isInitialized) refreshChatGrants()
    }

    override fun apply() {
        val snap = permissions.forProject(project)
        tickBoxes.forEach { (cat, box) ->
            if (box.isSelected != snap.covers(cat)) permissions.setTick(project, cat, box.isSelected)
        }
        val wanted = programEntries().toSet()
        (currentPrograms() - wanted).forEach { permissions.removeProgram(project, it) }
        (wanted - currentPrograms()).forEach { permissions.addProgram(project, it) }
        reset()
    }
}

package com.aijb.assistant.ui

import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.ToolPreview
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Font
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

interface ApprovalPrompter {
    suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): ApprovalDecision
    suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): ApprovalDecision
    suspend fun confirmGeneric(call: ToolCall): ApprovalDecision
}

class IdeApprovalGate(
    private val project: Project,
    private val autoApproveEdits: () -> Boolean,
    private val prompter: ApprovalPrompter = DialogPrompter(project),
) : ApprovalGate {
    override suspend fun review(call: ToolCall, preview: ToolPreview?): ApprovalDecision =
        when (preview) {
            is ToolPreview.FileChange ->
                if (autoApproveEdits()) {
                    ApprovalDecision.Approved
                } else {
                    prompter.confirmFile(call, preview)
                }
            is ToolPreview.Command -> prompter.confirmCommand(call, preview)
            null -> prompter.confirmGeneric(call)
        }
}

class DialogPrompter(private val project: Project) : ApprovalPrompter {
    override suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): ApprovalDecision =
        showDialog { FileApprovalDialog(project, call, change) }

    override suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): ApprovalDecision =
        showDialog { CommandApprovalDialog(project, call, command) }

    override suspend fun confirmGeneric(call: ToolCall): ApprovalDecision =
        showDialog { GenericApprovalDialog(project, call) }

    private suspend fun showDialog(build: () -> DialogWrapper): ApprovalDecision =
        withContext(Dispatchers.EDT) {
            val dialog = build()
            if (dialog.showAndGet()) {
                ApprovalDecision.Approved
            } else {
                ApprovalDecision.Rejected("rejected by user")
            }
        }
}

class FileApprovalDialog(
    private val project: Project,
    private val call: ToolCall,
    private val change: ToolPreview.FileChange,
) : DialogWrapper(project, true) {

    init {
        title = "Approve ${call.name}"
        setOKButtonText("Approve")
        setCancelButtonText("Reject")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val factory = DiffContentFactory.getInstance()
        val request = SimpleDiffRequest(
            change.path,
            factory.create(change.before ?: "", null as com.intellij.openapi.fileTypes.FileType?),
            factory.create(change.after, null as com.intellij.openapi.fileTypes.FileType?),
            "Current", "Proposed",
        )
        val panel = DiffManager.getInstance().createRequestPanel(project, disposable, null)
        panel.setRequest(request)
        return panel.component
    }
}

class CommandApprovalDialog(
    project: Project,
    private val call: ToolCall,
    private val command: ToolPreview.Command,
) : DialogWrapper(project, true) {

    init {
        title = "Approve ${call.name}"
        setOKButtonText("Approve")
        setCancelButtonText("Reject")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, 8))
        panel.border = JBUI.Borders.empty(8)
        panel.add(JLabel("Run command in ${command.cwd}:"), BorderLayout.NORTH)
        val area = JBTextArea(command.command, 4, 50)
        area.isEditable = false
        area.lineWrap = true
        area.font = Font(Font.MONOSPACED, Font.PLAIN, area.font.size)
        panel.add(JBScrollPane(area), BorderLayout.CENTER)
        return panel
    }
}

class GenericApprovalDialog(
    project: Project,
    private val call: ToolCall,
) : DialogWrapper(project, true) {

    init {
        title = "Approve ${call.name}"
        setOKButtonText("Approve")
        setCancelButtonText("Reject")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, 8))
        panel.border = JBUI.Borders.empty(8)
        panel.add(JLabel("Allow tool ${call.name}:"), BorderLayout.NORTH)
        val area = JBTextArea(call.arguments.toString(), 8, 50)
        area.isEditable = false
        area.lineWrap = true
        area.font = Font(Font.MONOSPACED, Font.PLAIN, area.font.size)
        panel.add(JBScrollPane(area), BorderLayout.CENTER)
        return panel
    }
}

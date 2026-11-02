package com.aijb.assistant.ui

import com.aijb.assistant.debug.DebugLogSink
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.tools.permissions.AlwaysGrantWriter
import com.aijb.assistant.tools.permissions.Grant
import com.aijb.assistant.tools.permissions.GrantScope
import com.aijb.assistant.tools.permissions.GrantTarget
import com.aijb.assistant.tools.permissions.PermissionsSnapshot
import com.aijb.assistant.tools.permissions.PromptResult
import com.aijb.assistant.tools.permissions.SessionGrants
import com.aijb.assistant.tools.permissions.ShellCommandSplitter
import com.aijb.assistant.tools.permissions.categoryOf
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
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
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

interface ApprovalPrompter {
    suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): PromptResult
    suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): PromptResult
    suspend fun confirmGeneric(call: ToolCall): PromptResult
}

/**
 * Bypass order: category tick or chat grant approves; for commands, every split program granted
 * approves; anything else prompts. Any failure inside the check falls through to the prompt.
 * [splitPrograms] parses a shell command into its program names; null means unparseable and the
 * command prompts. The default is [ShellCommandSplitter].
 */
class IdeApprovalGate(
    private val project: Project,
    private val permissions: () -> PermissionsSnapshot,
    private val grants: SessionGrants,
    private val prompter: ApprovalPrompter = DialogPrompter(project),
    private val always: AlwaysGrantWriter = AlwaysGrantWriter.DEFAULT,
    private val splitPrograms: (String) -> List<String>? = { ShellCommandSplitter.programsOrNull(it) },
) : ApprovalGate {
    override suspend fun review(call: ToolCall, preview: ToolPreview?): ApprovalDecision {
        try {
            if (covered(preview)) {
                grants.recordAutoApproved()
                audit(call, preview)
                return ApprovalDecision.Approved
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            LOG.warn("Permission check failed; prompting instead: ${e.javaClass.simpleName}")
        }
        val result = prompt(call, preview)
        if (result.decision is ApprovalDecision.Approved) record(result.grant)
        return result.decision
    }

    private fun covered(preview: ToolPreview?): Boolean {
        val category = categoryOf(preview) ?: return false
        val snapshot = permissions()
        if (snapshot.covers(category) || grants.covers(category)) return true
        if (preview is ToolPreview.Command) {
            val programs = splitPrograms(preview.command)
            if (!programs.isNullOrEmpty()) {
                val chat = grants.programs()
                return programs.all { it in snapshot.programs || it in chat }
            }
        }
        return false
    }

    private suspend fun prompt(call: ToolCall, preview: ToolPreview?): PromptResult = when (preview) {
        is ToolPreview.FileChange -> prompter.confirmFile(call, preview)
        is ToolPreview.Command -> prompter.confirmCommand(call, preview)
        else -> prompter.confirmGeneric(call)
    }

    private fun record(grant: Grant?) {
        grant ?: return
        try {
            when (grant.scope) {
                GrantScope.CHAT -> when (val t = grant.target) {
                    is GrantTarget.Category -> grants.grant(t.category)
                    is GrantTarget.Programs -> grants.grant(t.names)
                }
                GrantScope.ALWAYS -> always.record(project, grant.target)
            }
        } catch (e: Throwable) {
            LOG.warn("Could not record approval grant: ${e.javaClass.simpleName}")
        }
    }

    private fun audit(call: ToolCall, preview: ToolPreview?) {
        val detail = when (preview) {
            is ToolPreview.FileChange -> preview.path
            is ToolPreview.Command -> preview.command
            else -> call.name
        }
        DebugLogSink.log("auto-approve", call.name, categoryOf(preview)?.name ?: "-", detail)
    }

    companion object {
        private val LOG = Logger.getInstance(IdeApprovalGate::class.java)
    }
}

/** Shows an approval dialog; a seam so tests need no real window. */
fun interface DialogHost {
    fun show(dialog: ApprovalDialog)
}

/**
 * Approval dialogs are modeless so the chat's Stop button stays reachable while one is open.
 * Cancelling the waiting coroutine closes the dialog; at most one is open at a time because
 * tools run serially.
 */
class DialogPrompter(
    private val project: Project,
    private val host: DialogHost = DialogHost { it.show() },
) : ApprovalPrompter {
    override suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): PromptResult =
        PromptResult(showDialog { FileApprovalDialog(project, call, change) })

    override suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): PromptResult =
        PromptResult(showDialog { CommandApprovalDialog(project, call, command) })

    override suspend fun confirmGeneric(call: ToolCall): PromptResult =
        PromptResult(showDialog { GenericApprovalDialog(project, call) })

    private suspend fun showDialog(build: () -> ApprovalDialog): ApprovalDecision =
        withContext(Dispatchers.EDT) {
            suspendCancellableCoroutine { cont ->
                val dialog = build()
                dialog.onDecision = { decision -> if (cont.isActive) cont.resume(decision) }
                cont.invokeOnCancellation {
                    ApplicationManager.getApplication().invokeLater(
                        { if (!dialog.isDisposed) dialog.close(DialogWrapper.CANCEL_EXIT_CODE) },
                        ModalityState.any(),
                    )
                }
                host.show(dialog)
            }
        }
}

abstract class ApprovalDialog(project: Project) : DialogWrapper(project, true, IdeModalityType.MODELESS) {
    /** Called once with the user's choice (OK, Cancel, Esc or the window close button). */
    var onDecision: ((ApprovalDecision) -> Unit)? = null

    override fun doOKAction() {
        super.doOKAction()
        decide(ApprovalDecision.Approved)
    }

    override fun doCancelAction() {
        super.doCancelAction()
        decide(ApprovalDecision.Rejected("rejected by user"))
    }

    internal fun approve() = doOKAction()
    internal fun reject() = doCancelAction()

    private fun decide(decision: ApprovalDecision) {
        val callback = onDecision ?: return
        onDecision = null
        callback(decision)
    }
}

class FileApprovalDialog(
    private val project: Project,
    private val call: ToolCall,
    private val change: ToolPreview.FileChange,
) : ApprovalDialog(project) {

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
) : ApprovalDialog(project) {

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
) : ApprovalDialog(project) {

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

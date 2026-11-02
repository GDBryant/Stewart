package com.adb.stewart.ui

import com.adb.stewart.debug.DebugLogSink
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.permissions.AlwaysGrantWriter
import com.adb.stewart.tools.permissions.Grant
import com.adb.stewart.tools.permissions.GrantScope
import com.adb.stewart.tools.permissions.GrantTarget
import com.adb.stewart.tools.permissions.PermissionsSnapshot
import com.adb.stewart.tools.permissions.ApprovalCategory
import com.adb.stewart.tools.permissions.ProjectPermissions
import com.adb.stewart.tools.permissions.PromptResult
import com.adb.stewart.tools.permissions.SessionGrants
import com.adb.stewart.tools.permissions.ShellCommandSplitter
import com.adb.stewart.tools.permissions.categoryOf
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
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
    private val prompter: ApprovalPrompter =
        DialogPrompter(project, permissions = permissions, grants = grants),
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
    private val permissions: () -> PermissionsSnapshot = {
        ProjectPermissions.getInstance().forProject(project)
    },
    private val grants: SessionGrants = SessionGrants(),
    private val parse: (String) -> ShellCommandSplitter.Result = { ShellCommandSplitter.split(it) },
) : ApprovalPrompter {
    override suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): PromptResult =
        showDialog { FileApprovalDialog(project, call, change) }

    override suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): PromptResult =
        showDialog {
            val (programs, reason) = when (val r = parse(command.command)) {
                is ShellCommandSplitter.Parsed -> r.programs to null
                is ShellCommandSplitter.Unparseable -> null to r.reason
            }
            val granted = permissions().programs + grants.programs()
            CommandApprovalDialog(project, call, command, programs, reason, granted)
        }

    override suspend fun confirmGeneric(call: ToolCall): PromptResult =
        showDialog { GenericApprovalDialog(project, call) }

    private suspend fun showDialog(build: () -> ApprovalDialog): PromptResult =
        withContext(Dispatchers.EDT) {
            suspendCancellableCoroutine { cont ->
                val dialog = build()
                dialog.onDecision = { d -> if (cont.isActive) cont.resume(dialog.resultFor(d)) }
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
    enum class RememberChoice(private val label: String) {
        ONCE("Just once"),
        CHAT("Allow for this chat"),
        ALWAYS("Always allow in this project");

        override fun toString() = label
    }

    /** Called once with the user's choice (OK, Cancel, Esc or the window close button). */
    var onDecision: ((ApprovalDecision) -> Unit)? = null

    private val rememberCombo = ComboBox(RememberChoice.entries.toTypedArray())

    internal var rememberChoice: RememberChoice
        get() = rememberCombo.item
        set(value) {
            rememberCombo.item = value
        }

    /** What the current scope selection would grant; null when no program grant is expressible. */
    protected abstract fun grantTarget(): GrantTarget?

    internal fun resultFor(decision: ApprovalDecision): PromptResult {
        val grant = if (decision is ApprovalDecision.Approved && rememberChoice != RememberChoice.ONCE) {
            grantTarget()?.let {
                Grant(
                    if (rememberChoice == RememberChoice.ALWAYS) GrantScope.ALWAYS else GrantScope.CHAT,
                    it,
                )
            }
        } else {
            null
        }
        return PromptResult(decision, grant)
    }

    override fun createSouthAdditionalPanel(): JPanel {
        val panel = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        panel.add(JLabel("Remember:"))
        panel.add(rememberCombo)
        return panel
    }

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

    override fun grantTarget(): GrantTarget = GrantTarget.Category(ApprovalCategory.EDITS)
}

class CommandApprovalDialog(
    project: Project,
    private val call: ToolCall,
    private val command: ToolPreview.Command,
    private val programs: List<String>? = ShellCommandSplitter.programsOrNull(command.command),
    private val unparseableReason: String? = null,
    private val grantedPrograms: Set<String> = emptySet(),
) : ApprovalDialog(project) {

    enum class ScopeChoice {
        PROGRAMS,
        ALL,
    }

    private val ungranted: List<String> = programs.orEmpty().filter { it !in grantedPrograms }

    private val scopeCombo = ComboBox(ScopeChoice.entries.toTypedArray()).apply {
        renderer = javax.swing.ListCellRenderer { list, value, index, selected, focus ->
            val label = when (value) {
                ScopeChoice.PROGRAMS -> "These programs: ${ungranted.joinToString(", ")}"
                ScopeChoice.ALL, null -> "All shell commands"
            }
            javax.swing.DefaultListCellRenderer().getListCellRendererComponent(
                list, label, index, selected, focus,
            )
        }
        isEnabled = !ungranted.isEmpty()
    }

    internal var scopeChoice: ScopeChoice
        get() = if (scopeCombo.isEnabled) scopeCombo.item else ScopeChoice.ALL
        set(value) {
            if (scopeCombo.isEnabled || value == ScopeChoice.ALL) scopeCombo.item = value
        }

    init {
        title = "Approve ${call.name}"
        setOKButtonText("Approve")
        setCancelButtonText("Reject")
        init()
    }

    override fun grantTarget(): GrantTarget = when (scopeChoice) {
        ScopeChoice.PROGRAMS -> GrantTarget.Programs(ungranted.toSet())
        ScopeChoice.ALL -> GrantTarget.Category(ApprovalCategory.COMMANDS)
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

        val south = JPanel()
        south.layout = javax.swing.BoxLayout(south, javax.swing.BoxLayout.Y_AXIS)
        if (programs == null) {
            south.add(JLabel("Cannot split safely${unparseableReason?.let { ": $it" } ?: ""}."))
        } else {
            val shown = programs.joinToString("  ") {
                if (it in grantedPrograms) "<font color='gray'>$it</font>" else "<b>$it</b>"
            }
            south.add(JLabel("<html>Programs: $shown</html>"))
        }
        val scopeRow = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        scopeRow.add(JLabel("Scope:"))
        scopeRow.add(scopeCombo)
        south.add(scopeRow)
        south.add(JLabel("<html><font color='gray'>A program grant covers every run of that " +
            "program with any arguments.</font></html>"))
        panel.add(south, BorderLayout.SOUTH)
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

    override fun grantTarget(): GrantTarget = GrantTarget.Category(ApprovalCategory.OTHER)
}

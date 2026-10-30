package com.aijb.assistant.ui

import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.chat.CommandContext
import com.aijb.assistant.chat.ErrorHints
import com.aijb.assistant.chat.GitDiff
import com.aijb.assistant.chat.SlashCommands
import com.aijb.assistant.chat.UsageFormat
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.settings.AijbConfigurable
import com.aijb.assistant.settings.AijbSettingsListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Rectangle
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextField
import javax.swing.JTextArea
import javax.swing.Scrollable
import javax.swing.SwingUtilities
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ChatPanel @JvmOverloads constructor(
    private val project: Project,
    internal val session: ChatSession = ChatSession.getInstance(project),
    private val settings: AijbSettings = AijbSettings.getInstance(),
) : JPanel(BorderLayout()), Disposable {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    internal val modelCombo = JComboBox<ModelInfo>()
    internal val refreshButton = JButton("Refresh")
    internal val rolesButton = JButton("Roles")
    internal val clearButton = JButton("Clear")
    internal val statusLabel = JLabel(" ")
    internal val messagesPanel = MessagesContainer()
    internal val scrollPane: JScrollPane = JBScrollPane(messagesPanel)
    internal val inputArea = JBTextArea(3, 40)
    internal val sendButton = JButton("Send")

    @Volatile
    private var updatingCombo = false

    internal var lastModels: List<ModelInfo> = emptyList()
        private set

    internal class MessagesContainer : JPanel(), Scrollable {
        override fun getScrollableTracksViewportWidth() = true
        override fun getScrollableTracksViewportHeight() = false
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableUnitIncrement(visibleRect: Rectangle?, orientation: Int, direction: Int) = 16
        override fun getScrollableBlockIncrement(visibleRect: Rectangle?, orientation: Int, direction: Int) = 100
    }

    init {
        messagesPanel.layout = BoxLayout(messagesPanel, BoxLayout.Y_AXIS)

        modelCombo.renderer = object : SimpleListCellRenderer<ModelInfo>() {
            override fun customize(
                list: javax.swing.JList<out ModelInfo>,
                value: ModelInfo?,
                index: Int,
                selected: Boolean,
                hasFocus: Boolean,
            ) {
                text = value?.let { "${it.displayName} · ${it.ref.providerId}" } ?: ""
            }
        }
        modelCombo.addActionListener {
            if (!updatingCombo) onModelSelected()
        }

        val header = JPanel(BorderLayout())
        header.border = JBUI.Borders.empty(4)
        header.add(modelCombo, BorderLayout.CENTER)
        val headerButtons = JPanel()
        headerButtons.add(rolesButton)
        headerButtons.add(clearButton)
        headerButtons.add(refreshButton)
        header.add(headerButtons, BorderLayout.EAST)

        inputArea.lineWrap = true
        inputArea.wrapStyleWord = true
        inputArea.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    onSubmit()
                }
            }
        })
        val inputPanel = JPanel(BorderLayout())
        inputPanel.border = JBUI.Borders.empty(4)
        inputPanel.add(JBScrollPane(inputArea), BorderLayout.CENTER)
        inputPanel.add(sendButton, BorderLayout.EAST)

        val south = JPanel(BorderLayout())
        south.add(statusLabel, BorderLayout.NORTH)
        south.add(inputPanel, BorderLayout.CENTER)

        add(header, BorderLayout.NORTH)
        add(scrollPane, BorderLayout.CENTER)
        add(south, BorderLayout.SOUTH)

        sendButton.addActionListener { onSendOrStop() }
        refreshButton.addActionListener { loadModels() }
        rolesButton.addActionListener { showRolesPopup() }
        clearButton.addActionListener { onClear() }
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(AijbSettings.TOPIC, AijbSettingsListener { loadModels() })
        renderTranscript()
        loadModels()
    }

    /** Wipes the chat, usage totals and the saved history file. */
    internal fun onClear() {
        session.clearHistory()
        sendButton.text = "Send"
        renderTranscript()
        statusLabel.text = "History cleared"
    }

    private fun onModelSelected() {
        val ref = (modelCombo.selectedItem as? ModelInfo)?.ref
        val s = settings.state
        s.chatModel = ref?.encode()
        if (s.multiModel) s.plannerModel = ref?.encode()
    }

    internal fun showRolesPopup() {
        val panel = RolesPanel(lastModels, settings)
        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, panel)
            .setRequestFocus(true)
            .createPopup()
        popup.addListener(object : JBPopupListener {
            override fun onClosed(event: LightweightWindowEvent) {
                panel.apply()
            }
        })
        popup.showUnderneathOf(rolesButton)
    }

    private fun renderTranscript() {
        messagesPanel.removeAll()
        session.transcript.forEach { msg ->
            addMessage(msg.role.name.lowercase(), msg.content)
        }
        refreshMessages()
    }

    /** Inline Planner question (never a modal dialog, so Stop stays reachable). */
    internal var questionPanel: JPanel? = null
        private set
    internal var questionField: JTextField? = null
        private set
    internal var questionButtons: List<JButton> = emptyList()
        private set
    internal var questionAnswerButton: JButton? = null
        private set

    internal fun showQuestion(question: String, options: List<String>) {
        clearQuestion()
        val panel = JPanel(BorderLayout(0, 4))
        panel.border = JBUI.Borders.empty(4, 8)
        panel.alignmentX = LEFT_ALIGNMENT
        panel.maximumSize = Dimension(Int.MAX_VALUE, 200)
        val label = JTextArea("planner asks: $question")
        label.isEditable = false
        label.lineWrap = true
        label.wrapStyleWord = true
        label.background = UIUtil.getPanelBackground()
        panel.add(label, BorderLayout.NORTH)
        val buttons = options.map { option ->
            JButton(option).also { it.addActionListener { submitAnswer(option) } }
        }
        if (buttons.isNotEmpty()) {
            val row = JPanel()
            buttons.forEach { row.add(it) }
            panel.add(row, BorderLayout.CENTER)
        }
        val field = JTextField()
        val answer = JButton("Answer")
        val input = JPanel(BorderLayout(4, 0))
        input.add(field, BorderLayout.CENTER)
        input.add(answer, BorderLayout.EAST)
        val submit = { submitAnswer(field.text) }
        answer.addActionListener { submit() }
        field.addActionListener { submit() }
        panel.add(input, BorderLayout.SOUTH)
        questionPanel = panel
        questionField = field
        questionButtons = buttons
        questionAnswerButton = answer
        messagesPanel.add(panel)
        statusLabel.text = "Waiting for your answer"
        refreshMessages()
    }

    private fun submitAnswer(text: String) {
        val answer = text.trim()
        if (answer.isEmpty()) return
        if (session.answerQuestion(answer)) {
            clearQuestion()
            addMessage("user", answer)
            statusLabel.text = " "
        }
    }

    internal fun clearQuestion() {
        questionPanel?.let { messagesPanel.remove(it) }
        questionPanel = null
        questionField = null
        questionButtons = emptyList()
        questionAnswerButton = null
        refreshMessages()
    }

    internal fun messageAreas(): List<JTextArea> =
        messagesPanel.components.filterIsInstance<JTextArea>()

    private fun addMessage(role: String, content: String): JTextArea {
        val area = JTextArea("$role: $content")
        area.isEditable = false
        area.lineWrap = true
        area.wrapStyleWord = true
        area.font = UIUtil.getLabelFont()
        area.background = UIUtil.getPanelBackground()
        area.border = JBUI.Borders.empty(4, 8)
        area.maximumSize = Dimension(Int.MAX_VALUE, Int.MAX_VALUE)
        area.alignmentX = LEFT_ALIGNMENT
        messagesPanel.add(area)
        refreshMessages()
        return area
    }

    private fun refreshMessages() {
        messagesPanel.revalidate()
        messagesPanel.repaint()
        SwingUtilities.invokeLater {
            val bar = scrollPane.verticalScrollBar
            bar.value = bar.maximum
        }
    }

    private val running: Boolean
        get() = sendButton.text == "Stop"

    /** Slash-command output goes into the panel only, never into the transcript. */
    internal val commandContext = object : CommandContext {
        override val running: Boolean
            get() = this@ChatPanel.running

        override fun show(text: String) {
            addMessage("system", text)
        }

        override fun error(text: String) {
            addMessage("error", text)
        }

        override val usage: Usage?
            get() = session.sessionUsage

        override val models: List<ModelInfo>
            get() = lastModels

        override val currentModel: ModelInfo?
            get() = modelCombo.selectedItem as? ModelInfo

        override fun clear() = onClear()

        override fun openSettings() = openSettingsPage()

        override fun selectModel(model: ModelInfo) {
            modelCombo.selectedItem = model
        }

        override fun openModelPicker() {
            if (modelCombo.isShowing) modelCombo.showPopup()
        }

        override fun compact(focus: String?): Boolean = startCompaction(focus)

        override fun sendPrompt(prompt: String): Boolean {
            val info = selectedModelOrError() ?: return false
            startSend(prompt, info)
            return true
        }

        override fun review(focus: String?): Boolean {
            if (selectedModelOrError() == null) return false
            statusLabel.text = "Reading changes..."
            scope.launch {
                val diff = diffSource()
                withContext(Dispatchers.EDT) { onReviewDiff(diff, focus) }
            }
            return true
        }
    }

    /** `git diff HEAD` in the project; replaced in tests. Runs off the EDT. */
    internal var diffSource: () -> GitDiff.Result = {
        GitDiff.read(project.basePath?.let { java.nio.file.Path.of(it) })
    }

    private fun onReviewDiff(diff: GitDiff.Result, focus: String?) {
        statusLabel.text = " "
        when (val request = SlashCommands.reviewRequest(diff, focus)) {
            is SlashCommands.ReviewRequest.Message ->
                if (request.isError) commandContext.error(request.text) else commandContext.show(request.text)
            is SlashCommands.ReviewRequest.Send -> {
                // The diff was read in the background; the chat may have changed meanwhile.
                val info = modelCombo.selectedItem as? ModelInfo
                when {
                    running -> commandContext.error("/review is not available while running")
                    info == null -> statusLabel.text = "No model selected"
                    else -> startSend(request.prompt, info)
                }
            }
        }
    }

    private fun selectedModelOrError(): ModelInfo? {
        val info = modelCombo.selectedItem as? ModelInfo
        if (info == null) statusLabel.text = "No model selected"
        return info
    }

    private fun startCompaction(focus: String?): Boolean {
        val info = selectedModelOrError() ?: return false
        sendButton.text = "Stop"
        statusLabel.text = "Compacting..."
        session.compact(info.ref, focus, object : ChatListener {
            override fun onDelta(text: String) {}

            override fun onCompacted(beforeTokens: Int, afterTokens: Int) {
                addMessage("system", "Context compacted (~$beforeTokens → ~$afterTokens tokens)")
            }

            override fun onCompactionSkipped(reason: String) {
                addMessage("system", reason)
            }

            override fun onCompleted(usage: Usage?) {
                sendButton.text = "Send"
                statusLabel.text = UsageFormat.status(usage, session.sessionUsage)
            }

            override fun onFailed(message: String) {
                sendButton.text = "Send"
                statusLabel.text = "Failed: $message"
            }

            override fun onCancelled() {
                sendButton.text = "Send"
                statusLabel.text = "Cancelled"
            }
        })
        return true
    }

    /** Opens the plugin's Settings page; replaced in tests. */
    internal var openSettingsPage: () -> Unit = {
        ShowSettingsUtil.getInstance().showSettingsDialog(project, AijbConfigurable::class.java)
    }

    /** The button: Stop while running, otherwise submit. */
    private fun onSendOrStop() {
        if (running) {
            session.cancel()
            return
        }
        onSubmit()
    }

    /** Enter: runs a slash command (even mid-run); plain text is ignored while running. */
    private fun onSubmit() {
        val raw = inputArea.text
        SlashCommands.parse(raw)?.let { parsed ->
            if (SlashCommands.execute(parsed, commandContext)) inputArea.text = ""
            return
        }
        if (running) return
        val text = SlashCommands.plainText(raw).trim()
        if (text.isEmpty()) return
        val info = selectedModelOrError() ?: return
        inputArea.text = ""
        startSend(text, info)
    }

    private fun startSend(text: String, info: ModelInfo) {
        addMessage("user", text)
        var deltaArea: JTextArea? = addMessage("assistant", "")
        val toolAreas = mutableMapOf<String, Pair<JTextArea, String>>()
        val reply = StringBuilder()
        sendButton.text = "Stop"
        statusLabel.text = " "
        var compacted = false
        var compactionFailed = false
        session.send(text, info.ref, object : ChatListener {
            override fun onDelta(text: String) {
                reply.append(text)
                if (deltaArea == null) deltaArea = addMessage("assistant", "")
                deltaArea!!.text = "assistant: $reply"
                refreshMessages()
            }

            override fun onToolRequested(call: com.aijb.assistant.provider.ToolCall) {
                val args = call.arguments.toString().let {
                    if (it.length > 200) it.take(200) + "…" else it
                }
                toolAreas[call.id] = addMessage("tool", "${call.name} $args") to args
                deltaArea = null
                reply.setLength(0)
            }

            override fun onToolOutcome(
                call: com.aijb.assistant.provider.ToolCall,
                outcome: com.aijb.assistant.tools.ToolOutcome,
            ) {
                val result = when (outcome) {
                    is com.aijb.assistant.tools.ToolOutcome.Success -> outcome.content.take(2000)
                    is com.aijb.assistant.tools.ToolOutcome.Rejected -> "Rejected: ${outcome.reason}"
                    is com.aijb.assistant.tools.ToolOutcome.Failure -> "Failed: ${outcome.message}"
                    is com.aijb.assistant.tools.ToolOutcome.Invalid -> "Invalid: ${outcome.reason}"
                    is com.aijb.assistant.tools.ToolOutcome.Uncertain -> "Uncertain: ${outcome.reason}"
                }
                toolAreas[call.id]?.let { (area, args) ->
                    area.text = "tool: ${call.name} $args\n$result"
                }
                refreshMessages()
            }

            override fun onLevelStarted(role: com.aijb.assistant.agents.AgentRole, context: String) {
                deltaArea = null
                reply.setLength(0)
                addMessage("${role.name.lowercase()} · $context", "")
            }

            override fun onQuestion(question: String, options: List<String>) {
                deltaArea = null
                reply.setLength(0)
                showQuestion(question, options)
            }

            override fun onCompacted(beforeTokens: Int, afterTokens: Int) {
                compacted = true
                statusLabel.text = "Context compacted (~$beforeTokens → ~$afterTokens tokens)"
            }

            override fun onCompactionFailed(message: String) {
                compactionFailed = true
                statusLabel.text = "Compaction failed: $message"
            }

            override fun onCompleted(usage: Usage?) {
                clearQuestion()
                sendButton.text = "Send"
                val base = UsageFormat.status(usage, session.sessionUsage)
                statusLabel.text = base + when {
                    compacted -> " · context compacted"
                    compactionFailed -> " · compaction failed"
                    else -> ""
                }
            }

            override fun onFailed(message: String) {
                clearQuestion()
                sendButton.text = "Send"
                statusLabel.text = "Failed: $message"
            }

            override fun onFailedWithCode(message: String, code: String?) {
                onFailed(message)
                val hint = ErrorHints.hint(code) ?: return
                addMessage("error", "$message\n$hint")
            }

            override fun onCancelled() {
                clearQuestion()
                sendButton.text = "Send"
                statusLabel.text = "Cancelled"
            }

            override fun onCancelledWithOutcomes(uncertainOutcomes: Int) {
                onCancelled()
                if (uncertainOutcomes > 0) {
                    statusLabel.text = "Cancelled · $uncertainOutcomes tool outcome(s) uncertain, " +
                        "side effects not rolled back"
                }
            }
        })
    }

    internal fun loadModels() {
        val previous = (modelCombo.selectedItem as? ModelInfo)?.ref
        statusLabel.text = "Loading models..."
        val providers = session.providers()
        scope.launch {
            val results = providers.map { p ->
                async {
                    try {
                        Result.success(p.listModels())
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Result.failure(e)
                    }
                }
            }.awaitAll()
            val models = mutableListOf<ModelInfo>()
            val failures = mutableListOf<String>()
            providers.forEachIndexed { i, p ->
                results[i]
                    .onSuccess { models += it }
                    .onFailure { failures += "${p.id} unavailable: ${it.message ?: "error"}" }
            }
            withContext(Dispatchers.EDT) { showModels(models, failures, previous) }
        }
    }

    private fun showModels(models: List<ModelInfo>, failures: List<String>, previous: ModelRef?) {
        lastModels = models
        updatingCombo = true
        try {
            modelCombo.removeAllItems()
            models.forEach { modelCombo.addItem(it) }
            val restoreRef = previous
                ?: ModelRef.decode(settings.state.chatModel)
            val idx = models.indexOfFirst { it.ref == restoreRef }
            if (idx >= 0) modelCombo.selectedIndex = idx
        } finally {
            updatingCombo = false
        }
        statusLabel.text = when {
            failures.isNotEmpty() -> failures.joinToString("; ")
            models.isEmpty() -> "No models found"
            else -> " "
        }
    }

    override fun dispose() {
        session.cancel()
        scope.cancel()
    }
}

package com.aijb.assistant.ui

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.chat.ActivityFormat
import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.chat.CommandContext
import com.aijb.assistant.chat.ErrorHints
import com.aijb.assistant.chat.GitDiff
import com.aijb.assistant.chat.ContextCompactor
import com.aijb.assistant.chat.InitFiles
import com.aijb.assistant.chat.PromptHistory
import com.aijb.assistant.provider.Role
import com.aijb.assistant.chat.PermissionsView
import com.aijb.assistant.chat.SlashCommand
import com.aijb.assistant.chat.SlashCommands
import com.aijb.assistant.chat.UsageFormat
import com.aijb.assistant.debug.DebugLogSink
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.settings.AijbConfigurable
import com.aijb.assistant.settings.AijbSettingsListener
import com.aijb.assistant.tools.permissions.ApprovalCategory
import com.aijb.assistant.tools.permissions.PermissionsListener
import com.aijb.assistant.tools.permissions.ProjectPermissions
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.openapi.ui.Messages
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.ui.AsyncProcessIcon
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Point
import java.awt.Rectangle
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextField
import javax.swing.JTextArea
import javax.swing.Scrollable
import javax.swing.SwingUtilities
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
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
    internal val modeLabel = JLabel(" ")
    internal val statusLabel = JLabel(" ")
    internal val bypassButton = JButton("Bypass")
    internal val bypassLabel = JLabel(" ")
    internal val messagesPanel = MessagesContainer()
    internal val scrollPane: JScrollPane = JBScrollPane(messagesPanel)
    internal val inputArea = JBTextArea(3, 40)
    internal val sendButton = JButton("Send")
    internal val busyIcon = AsyncProcessIcon("aijb-busy").apply { isVisible = false; suspend() }
    internal val activityLabel = JLabel(" ")

    /** Slash-command autocomplete: the list lives in a non-focusable popup; keys stay in the input. */
    internal val completionList = JBList<SlashCommand>()
    private var completionPopup: JBPopup? = null
    private var swallowTab = false

    /** Esc hides completions until the text changes. */
    private var dismissedFor: String? = null

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
        DebugLogSink.configure(
            settings.state.debugLogEnabled,
            settings.state.debugLogFolder.orEmpty(),
            settings.state.debugLogRetentionDays,
        )

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
        headerButtons.add(bypassButton)
        headerButtons.add(rolesButton)
        headerButtons.add(clearButton)
        headerButtons.add(refreshButton)
        header.add(headerButtons, BorderLayout.EAST)
        header.add(modeLabel, BorderLayout.SOUTH)

        inputArea.lineWrap = true
        inputArea.wrapStyleWord = true
        inputArea.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (handleCompletionKey(e)) {
                    e.consume()
                    return
                }
                // Recall only on plain Up/Down. While browsing, Up/Down move the caret within a
                // multi-line prompt first and recall only from its first/last line. Up-recall puts
                // the caret at the start and Down-recall at the end, so the same key keeps walking.
                val plain = e.modifiersEx == 0
                val text = inputArea.text
                val caret = inputArea.caretPosition.coerceIn(0, text.length)
                if (plain && e.keyCode == KeyEvent.VK_UP &&
                    (text.isEmpty() || (history.browsing && '\n' !in text.substring(0, caret)))
                ) {
                    if (!history.browsing) {
                        history.reset(
                            session.transcript
                                .filter { it.role == Role.USER && !it.content.startsWith(ContextCompactor.SUMMARY_PREFIX) }
                                .map { it.content },
                        )
                    }
                    history.older()?.let { recall(it, atStart = true) }
                    e.consume()
                    return
                }
                if (plain && e.keyCode == KeyEvent.VK_DOWN && history.browsing && '\n' !in text.substring(caret)) {
                    history.newer()?.let { recall(it, atStart = false) }
                    e.consume()
                    return
                }
                if (e.keyCode == KeyEvent.VK_ENTER) {
                    e.consume()
                    if (e.isShiftDown) inputArea.replaceSelection("\n") else onSubmit()
                }
            }

            override fun keyTyped(e: KeyEvent) {
                if (e.keyChar == '\n') {
                    e.consume()
                    return
                }
                // The Tab that inserted a completion must not also type a tab character.
                if (e.keyChar == '\t' && swallowTab) {
                    swallowTab = false
                    e.consume()
                }
            }
        })
        inputArea.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = edited()
            override fun removeUpdate(e: DocumentEvent) = edited()
            override fun changedUpdate(e: DocumentEvent) = edited()

            private fun edited() {
                if (!recalling) history.stopBrowsing()
                updateCompletions()
            }
        })
        completionList.cellRenderer = object : SimpleListCellRenderer<SlashCommand>() {
            override fun customize(
                list: javax.swing.JList<out SlashCommand>,
                value: SlashCommand?,
                index: Int,
                selected: Boolean,
                hasFocus: Boolean,
            ) {
                text = value?.let { "/${it.name} ${it.argHint}".trimEnd() + " — ${it.description}" } ?: ""
            }
        }
        completionList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                completionList.selectedValue?.let { insertCompletion(it) }
            }
        })
        val inputPanel = JPanel(BorderLayout())
        inputPanel.border = JBUI.Borders.empty(4)
        inputPanel.add(JBScrollPane(inputArea), BorderLayout.CENTER)
        val sendPanel = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, 4, 0))
        sendPanel.add(sendButton)
        sendPanel.add(busyIcon)
        inputPanel.add(sendPanel, BorderLayout.EAST)

        val south = JPanel(BorderLayout())
        val labels = JPanel(BorderLayout())
        val statusRow = JPanel(BorderLayout(8, 0))
        statusRow.add(activityLabel, BorderLayout.WEST)
        statusRow.add(statusLabel, BorderLayout.CENTER)
        labels.add(statusRow, BorderLayout.CENTER)
        labels.add(bypassLabel, BorderLayout.EAST)
        south.add(labels, BorderLayout.NORTH)
        south.add(inputPanel, BorderLayout.CENTER)

        add(header, BorderLayout.NORTH)
        add(scrollPane, BorderLayout.CENTER)
        add(south, BorderLayout.SOUTH)

        sendButton.addActionListener { onSendOrStop() }
        refreshButton.addActionListener { loadModels() }
        rolesButton.addActionListener { showRolesPopup() }
        clearButton.addActionListener { onClear() }
        bypassButton.addActionListener { showBypassPopup() }
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(AijbSettings.TOPIC, AijbSettingsListener {
                updateSelectorState()
                loadModels()
            })
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(ProjectPermissions.TOPIC, PermissionsListener { hash ->
                if (hash.isEmpty() || hash == project.locationHash) {
                    ApplicationManager.getApplication().invokeLater { refreshBypassState() }
                }
            })
        refreshBypassState()
        renderTranscript()
        updateSelectorState()
        loadModels()
    }

    /**
     * Single-model mode: the main picker is the only selector. Multi-model mode: the three role
     * selectors drive the levels, so the main picker is disabled rather than silently ignored.
     */
    internal fun updateSelectorState() {
        val multi = settings.state.multiModel
        modelCombo.isEnabled = !multi
        modelCombo.toolTipText = if (multi) {
            "Multi-model mode: set the Planner, Executor and Worker models in Roles"
        } else {
            "Model for this chat"
        }
        refreshModeLabel()
    }

    private fun refreshModeLabel() {
        val st = settings.state
        val effort = settings.effortLevel.label
        modeLabel.text = if (st.multiModel) {
            val routes = AgentRole.entries.joinToString(" · ") { role ->
                "${role.name.lowercase()}→${settings.roleModel(role)?.encode() ?: "unset"}"
            }
            "mode=multi · effort=$effort · $routes"
        } else {
            val model = ModelRef.decode(st.chatModel)?.encode() ?: "unset"
            "mode=single · effort=$effort · model=$model"
        }
    }

    /** Wipes the chat, usage totals and the saved history file. */
    internal fun onClear() {
        session.clearHistory()
        setBusy(false)
        renderTranscript()
        refreshBypassState()
        statusLabel.text = "History cleared"
    }

    private fun onModelSelected() {
        val ref = (modelCombo.selectedItem as? ModelInfo)?.ref
        settings.state.chatModel = ref?.encode()
        refreshModeLabel()
    }

    internal fun showRolesPopup() {
        val panel = RolesPanel(lastModels, settings) { refreshModeLabel() }
        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, panel)
            .setRequestFocus(true)
            .createPopup()
        popup.addListener(object : JBPopupListener {
            override fun onClosed(event: LightweightWindowEvent) {
                panel.apply()
                updateSelectorState()
            }
        })
        popup.showUnderneathOf(rolesButton)
    }

    private val permissions: ProjectPermissions
        get() = ProjectPermissions.getInstance()

    /** Asks before a Commands/Other tick is enabled; replaced in tests. */
    internal var confirmBypass: (ApprovalCategory) -> Boolean = { category ->
        Messages.showYesNoDialog(
            project,
            "Bypass ${category.name.lowercase()} approvals for this project? " +
                "Every guard for this category is disabled until you turn it off.",
            "AIJB Permissions",
            "Enable",
            "Cancel",
            null,
        ) == Messages.YES
    }

    /** Opens the permissions settings page; replaced in tests. */
    internal var openPermissionsPage: () -> Unit = {
        ShowSettingsUtil.getInstance()
            .showSettingsDialog(project, com.aijb.assistant.settings.PermissionsConfigurable::class.java)
    }

    /** Writes a project tick, asking first for Commands/Other. */
    internal fun setBypassTick(category: ApprovalCategory, enabled: Boolean) {
        if (enabled && category != ApprovalCategory.EDITS && !confirmBypass(category)) return
        permissions.setTick(project, category, enabled)
    }

    /** Clears this chat's session grants. */
    internal fun clearChatGrants() {
        session.sessionGrants.clear()
        refreshBypassState()
    }

    private fun categoryLabel(category: ApprovalCategory): String = when (category) {
        ApprovalCategory.EDITS -> "edits"
        ApprovalCategory.COMMANDS -> "cmds"
        ApprovalCategory.OTHER -> "other"
    }

    /** Active categories (tick or chat grant) plus the total program grant count. */
    internal fun bypassSummary(): Pair<List<String>, Int> {
        val snap = permissions.forProject(project)
        val cats = ApprovalCategory.entries
            .filter { snap.covers(it) || session.sessionGrants.covers(it) }
            .map(::categoryLabel)
        val programs = (snap.programs + session.sessionGrants.programs()).size
        return cats to programs
    }

    internal fun refreshBypassState() {
        val (cats, programs) = bypassSummary()
        val text = cats.joinToString(", ") + if (programs > 0) {
            (if (cats.isEmpty()) "" else " ") + "+$programs"
        } else {
            ""
        }
        bypassButton.text = if (text.isEmpty()) "Bypass" else "Bypass: $text"
        bypassButton.toolTipText =
            "${session.sessionGrants.autoApprovedCount()} call(s) auto-approved this chat"
        bypassLabel.text = if (text.isEmpty()) " " else "bypass: $text"
    }

    /** The popup contents; exposed so tests can drive the checkboxes without a real popup. */
    internal fun bypassPanel(): JPanel {
        val snap = permissions.forProject(project)
        val panel = JPanel()
        panel.layout = BoxLayout(panel, BoxLayout.Y_AXIS)
        panel.border = JBUI.Borders.empty(8)
        for (category in ApprovalCategory.entries) {
            val box = JCheckBox(
                "Always allow ${category.name.lowercase()} in this project",
                snap.covers(category),
            )
            box.addActionListener {
                if (box.isSelected && category != ApprovalCategory.EDITS && !confirmBypass(category)) {
                    box.isSelected = false
                } else {
                    permissions.setTick(project, category, box.isSelected)
                }
            }
            panel.add(box)
        }
        panel.add(JButton("Clear chat grants").also { it.addActionListener { clearChatGrants() } })
        panel.add(JButton("Manage…").also { it.addActionListener { openPermissionsPage() } })
        return panel
    }

    internal fun showBypassPopup() {
        val panel = bypassPanel()
        JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, panel)
            .setRequestFocus(true)
            .createPopup()
            .showUnderneathOf(bypassButton)
    }

    private fun renderTranscript() {
        messagesPanel.removeAll()
        session.transcript.forEach { msg ->
            addMessage(msg.role.name.lowercase(), msg.content)
        }
        refreshMessages()
    }

    internal val completionItems: List<SlashCommand>
        get() = (0 until completionList.model.size).map { completionList.model.getElementAt(it) }

    private val history = PromptHistory()
    private var recalling = false

    /** Puts a recalled prompt in the input without ending the browse. */
    private fun recall(text: String, atStart: Boolean) {
        recalling = true
        try {
            inputArea.text = text
            inputArea.caretPosition = if (atStart) 0 else text.length
        } finally {
            recalling = false
        }
    }

    internal fun updateCompletions() {
        val text = inputArea.text
        if (dismissedFor != null && dismissedFor != text) dismissedFor = null
        val items = if (dismissedFor == null) SlashCommands.complete(text) else emptyList()
        completionList.setListData(items.toTypedArray())
        if (items.isEmpty()) {
            hideCompletionPopup()
            return
        }
        completionList.selectedIndex = 0
        showCompletionPopup()
    }

    private fun showCompletionPopup() {
        if (!inputArea.isShowing) return
        completionPopup?.takeIf { it.isVisible }?.let {
            it.pack(true, true)
            return
        }
        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(JBScrollPane(completionList), null)
            .setRequestFocus(false)
            .setFocusable(false)
            .setCancelOnClickOutside(true)
            .createPopup()
        completionPopup = popup
        val height = completionList.preferredSize.height + JBUI.scale(8)
        popup.show(RelativePoint(inputArea, Point(0, -height)))
    }

    private fun hideCompletionPopup() {
        completionPopup?.cancel()
        completionPopup = null
    }

    private fun insertCompletion(command: SlashCommand) {
        inputArea.text = "/${command.name} "
        inputArea.caretPosition = inputArea.text.length
    }

    /**
     * Keys while completions are listed: Tab inserts the selection, Enter too unless the text is
     * already a full command name (then Enter runs it), Up/Down move, Esc hides. True = consumed.
     */
    internal fun handleCompletionKey(e: KeyEvent): Boolean {
        val items = completionItems
        if (items.isEmpty()) return false
        val selected = completionList.selectedValue ?: items[0]
        return when (e.keyCode) {
            KeyEvent.VK_TAB -> {
                swallowTab = true
                insertCompletion(selected)
                true
            }
            KeyEvent.VK_ENTER -> {
                if (e.isShiftDown || SlashCommands.find(inputArea.text.substring(1).lowercase()) != null) {
                    false
                } else {
                    insertCompletion(selected)
                    true
                }
            }
            KeyEvent.VK_DOWN, KeyEvent.VK_UP -> {
                val step = if (e.keyCode == KeyEvent.VK_DOWN) 1 else -1
                completionList.selectedIndex = (completionList.selectedIndex + step).mod(items.size)
                true
            }
            KeyEvent.VK_ESCAPE -> {
                dismissedFor = inputArea.text
                updateCompletions()
                true
            }
            else -> false
        }
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

    /** `/init` file check; replaced in tests. Runs off the EDT. */
    internal var initFilesSource: () -> InitFiles.Result = {
        InitFiles.ensure(project.basePath?.let { java.nio.file.Path.of(it) })
    }

    internal var choicePanel: JPanel? = null
        private set

    private fun showInitChoice(result: InitFiles.Result) {
        if (result.error != null) {
            addMessage("error", result.summary())
            return
        }
        addMessage("system", "Init: ${result.summary()}")
        showChoice(
            SlashCommands.INIT_QUESTION,
            listOf(SlashCommands.INIT_INVESTIGATE, SlashCommands.INIT_STOP),
        ) { option ->
            if (option == SlashCommands.INIT_INVESTIGATE) {
                commandContext.sendPrompt(SlashCommands.INIT_PROMPT)
            } else {
                addMessage("system", "Init: stopped here.")
            }
        }
    }

    /** One-off inline choice (not a Planner question); the pick calls [onPick]. */
    private fun showChoice(question: String, options: List<String>, onPick: (String) -> Unit) {
        clearChoice()
        val panel = JPanel(BorderLayout(0, 4))
        panel.border = JBUI.Borders.empty(4, 8)
        panel.alignmentX = LEFT_ALIGNMENT
        panel.maximumSize = Dimension(Int.MAX_VALUE, 200)
        val label = JTextArea(question)
        label.isEditable = false
        label.lineWrap = true
        label.wrapStyleWord = true
        label.background = UIUtil.getPanelBackground()
        panel.add(label, BorderLayout.NORTH)
        val row = JPanel()
        options.forEach { option ->
            row.add(JButton(option).also { it.addActionListener { clearChoice(); onPick(option) } })
        }
        panel.add(row, BorderLayout.CENTER)
        choicePanel = panel
        messagesPanel.add(panel)
        refreshMessages()
    }

    internal fun clearChoice() {
        choicePanel?.let { messagesPanel.remove(it) }
        choicePanel = null
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
        clearChoice()
    }

    private class MessageRow : JPanel(BorderLayout()) {
        override fun getMaximumSize() = Dimension(Int.MAX_VALUE, preferredSize.height)
    }

    /** One-line clickable header (`▸`/`▾`) over an output body that is hidden until expanded. */
    internal class ToolRow(private val title: String) : JPanel(BorderLayout()) {
        private val header = JLabel()
        internal val body = JTextArea()
        private var suffix = ""
        val bodyVisible: Boolean get() = body.isVisible
        val headerText: String get() = header.text

        init {
            isOpaque = false
            alignmentX = LEFT_ALIGNMENT
            header.font = UIUtil.getLabelFont()
            header.border = JBUI.Borders.empty(2, 8)
            header.cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            header.addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) = toggle()
            })
            body.isEditable = false
            body.lineWrap = true
            body.wrapStyleWord = true
            body.font = UIUtil.getLabelFont()
            body.border = JBUI.Borders.empty(2, 20)
            body.isVisible = false
            add(header, BorderLayout.NORTH)
            add(body, BorderLayout.CENTER)
            render()
        }

        private fun render() {
            header.text = (if (body.isVisible) "▾ " else "▸ ") + title + suffix
        }

        fun toggle() {
            body.isVisible = !body.isVisible
            render()
            revalidate()
            repaint()
        }

        fun complete(statusSuffix: String, bodyText: String, expand: Boolean) {
            suffix = statusSuffix
            body.text = bodyText.take(TOOL_OUTPUT_CHARS)
            body.isVisible = expand
            render()
            revalidate()
            repaint()
        }

        override fun getMaximumSize() = Dimension(Int.MAX_VALUE, preferredSize.height)
    }

    internal fun addToolRow(title: String): ToolRow {
        val row = ToolRow(title)
        messagesPanel.add(row)
        refreshMessages()
        return row
    }

    internal fun toolRows(): List<ToolRow> = messagesPanel.components.filterIsInstance<ToolRow>()

    internal fun addToolRowForTest(name: String, args: String, outcome: com.aijb.assistant.tools.ToolOutcome): ToolRow =
        addToolRow("tool: $name $args").also { completeToolRow(it, outcome) }

    private fun completeToolRow(row: ToolRow, outcome: com.aijb.assistant.tools.ToolOutcome) {
        val (suffix, body) = when (outcome) {
            is com.aijb.assistant.tools.ToolOutcome.Success -> " · ✓" to outcome.content
            is com.aijb.assistant.tools.ToolOutcome.Rejected -> " · Rejected" to outcome.reason
            is com.aijb.assistant.tools.ToolOutcome.Failure -> " · Failed" to outcome.message
            is com.aijb.assistant.tools.ToolOutcome.Invalid -> " · Invalid" to outcome.reason
            is com.aijb.assistant.tools.ToolOutcome.Uncertain -> " · Uncertain" to outcome.reason
        }
        row.complete(suffix, body, outcome !is com.aijb.assistant.tools.ToolOutcome.Success)
    }

    internal fun messageAreas(): List<JTextArea> =
        messagesPanel.components.flatMap { c ->
            when (c) {
                is JTextArea -> listOf(c)
                is MessageRow -> c.components.filterIsInstance<JTextArea>()
                is ToolRow -> listOf(c.body)
                else -> emptyList()
            }
        }

    internal fun addMessage(role: String, content: String): JTextArea {
        val isUser = role == "user"
        val area = JTextArea(if (isUser) content else "$role: $content")
        area.isEditable = false
        area.lineWrap = true
        area.wrapStyleWord = true
        area.font = UIUtil.getLabelFont()
        area.background = if (isUser) USER_BUBBLE_BG else UIUtil.getPanelBackground()
        area.border = JBUI.Borders.empty(4, 8)
        val row = MessageRow()
        row.isOpaque = false
        row.alignmentX = LEFT_ALIGNMENT
        if (isUser) {
            row.border = JBUI.Borders.emptyLeft(60)
            row.add(area, BorderLayout.EAST)
        } else {
            row.add(area, BorderLayout.CENTER)
        }
        messagesPanel.add(row)
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

    private var activeRole: AgentRole? = null
    private var activeContext: String? = null
    private var activeTool: String? = null

    private fun setBusy(on: Boolean) {
        sendButton.text = if (on) "Stop" else "Send"
        busyIcon.isVisible = on
        if (on) {
            busyIcon.resume()
        } else {
            busyIcon.suspend()
            activeRole = null
            activeContext = null
            activeTool = null
        }
        updateActivity()
    }

    private fun updateActivity() {
        activityLabel.text = if (running) ActivityFormat.label(activeRole, activeContext, activeTool) else " "
    }

    /** Test hook: drives the level-started callback as the session would. */
    internal fun simulateLevelStartedForTest(role: AgentRole, context: String) {
        setBusy(true)
        chatListener().onLevelStarted(role, context)
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

        override val multiModel: Boolean
            get() = settings.state.multiModel

        override fun roleModels(): Map<AgentRole, ModelRef?> =
            AgentRole.entries.associateWith { settings.roleModel(it) }

        override fun selectRoleModel(role: AgentRole, model: ModelInfo) {
            settings.setRoleModel(role, model.ref)
            refreshModeLabel()
        }

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

        override fun init(): Boolean {
            if (selectedModelOrError() == null) return false
            scope.launch {
                val result = initFilesSource()
                withContext(Dispatchers.EDT) { showInitChoice(result) }
            }
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

        override val permissions = object : PermissionsView {
            private val store get() = ProjectPermissions.getInstance()
            override val ticks get() = store.forProject(project).ticks
            override val alwaysPrograms get() = store.forProject(project).programs
            override val projectPath get() = store.pathFor(project)
            override val chatCategories get() = session.sessionGrants.categories()
            override val chatPrograms get() = session.sessionGrants.programs()

            override fun clearChat() = clearChatGrants()

            override fun revokeCategory(category: ApprovalCategory) {
                store.setTick(project, category, false)
                session.sessionGrants.revoke(category)
                refreshBypassState()
            }

            override fun revokeProgram(program: String) {
                store.removeProgram(project, program)
                session.sessionGrants.revokeProgram(program)
                refreshBypassState()
            }

            override fun resetProject() {
                store.resetProject(project)
                refreshBypassState()
            }
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
        setBusy(true)
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
                setBusy(false)
                statusLabel.text = UsageFormat.status(usage, session.sessionUsage)
            }

            override fun onFailed(message: String) {
                setBusy(false)
                statusLabel.text = "Failed: $message"
            }

            override fun onCancelled() {
                setBusy(false)
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
        history.stopBrowsing()
        startSend(text, info)
    }

    private fun startSend(text: String, info: ModelInfo) {
        addMessage("user", text)
        val initialArea = addMessage("assistant", "")
        setBusy(true)
        statusLabel.text = " "
        session.send(text, info.ref, chatListener(initialArea))
    }

    private class SendState(var deltaArea: JTextArea?) {
        val toolRows = mutableMapOf<String, ToolRow>()
        val reply = StringBuilder()
        var compacted = false
        var compactionFailed = false
    }

    /** The listener driving the transcript and status for one send. */
    internal fun chatListener(initialArea: JTextArea? = null): ChatListener {
        val st = SendState(initialArea)
        return object : ChatListener {
            override fun onDelta(text: String) {
                st.reply.append(text)
                if (st.deltaArea == null) st.deltaArea = addMessage("assistant", "")
                st.deltaArea!!.text = "assistant: ${st.reply}"
                refreshMessages()
            }

            override fun onToolRequested(call: com.aijb.assistant.provider.ToolCall) {
                activeTool = call.name.ifBlank { null }
                updateActivity()
                val args = call.arguments.toString().let {
                    if (it.length > 200) it.take(200) + "…" else it
                }
                st.toolRows[call.id] = addToolRow("tool: ${call.name} $args")
                st.deltaArea = null
                st.reply.setLength(0)
            }

            override fun onToolOutcome(
                call: com.aijb.assistant.provider.ToolCall,
                outcome: com.aijb.assistant.tools.ToolOutcome,
            ) {
                st.toolRows[call.id]?.let { completeToolRow(it, outcome) }
                activeTool = null
                updateActivity()
                refreshMessages()
            }

            override fun onLevelStarted(role: com.aijb.assistant.agents.AgentRole, context: String) {
                st.deltaArea = null
                st.reply.setLength(0)
                addMessage("${role.name.lowercase()} · $context", "")
                activeRole = role
                activeContext = context
                activeTool = null
                updateActivity()
            }

            override fun onQuestion(question: String, options: List<String>) {
                st.deltaArea = null
                st.reply.setLength(0)
                showQuestion(question, options)
            }

            override fun onCompacted(beforeTokens: Int, afterTokens: Int) {
                st.compacted = true
                statusLabel.text = "Context compacted (~$beforeTokens → ~$afterTokens tokens)"
            }

            override fun onCompactionFailed(message: String) {
                st.compactionFailed = true
                statusLabel.text = "Compaction failed: $message"
            }

            override fun onCompleted(usage: Usage?) {
                clearQuestion()
                setBusy(false)
                val base = UsageFormat.status(usage, session.sessionUsage)
                statusLabel.text = base + when {
                    st.compacted -> " · context compacted"
                    st.compactionFailed -> " · compaction failed"
                    else -> ""
                }
            }

            override fun onFailed(message: String) {
                clearQuestion()
                setBusy(false)
                statusLabel.text = "Failed: $message"
            }

            override fun onFailedWithCode(message: String, code: String?) {
                onFailed(message)
                val hint = ErrorHints.hint(code) ?: return
                addMessage("error", "$message\n$hint")
            }

            override fun onCancelled() {
                clearQuestion()
                setBusy(false)
                statusLabel.text = "Cancelled"
            }

            override fun onCancelledWithOutcomes(uncertainOutcomes: Int) {
                onCancelled()
                if (uncertainOutcomes > 0) {
                    statusLabel.text = "Cancelled · $uncertainOutcomes tool outcome(s) uncertain, " +
                        "side effects not rolled back"
                }
            }
        }
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
        refreshModeLabel()
    }

    override fun dispose() {
        hideCompletionPopup()
        session.cancel()
        scope.cancel()
        com.intellij.openapi.util.Disposer.dispose(busyIcon)
    }

    private companion object {
        val USER_BUBBLE_BG = JBColor(Color(0xDCE9FF), Color(0x2F4468))
        const val TOOL_OUTPUT_CHARS = 2000
    }
}

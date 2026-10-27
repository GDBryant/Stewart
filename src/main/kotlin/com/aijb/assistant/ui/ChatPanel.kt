package com.aijb.assistant.ui

import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.settings.AijbSettingsListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
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
        headerButtons.add(refreshButton)
        header.add(headerButtons, BorderLayout.EAST)

        inputArea.lineWrap = true
        inputArea.wrapStyleWord = true
        inputArea.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    onSendOrStop()
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
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(AijbSettings.TOPIC, AijbSettingsListener { loadModels() })
        renderTranscript()
        loadModels()
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

    private fun onSendOrStop() {
        if (sendButton.text == "Stop") {
            session.cancel()
            return
        }
        val text = inputArea.text.trim()
        if (text.isEmpty()) return
        val info = modelCombo.selectedItem as? ModelInfo
        if (info == null) {
            statusLabel.text = "No model selected"
            return
        }
        inputArea.text = ""
        addMessage("user", text)
        val deltaArea = addMessage("assistant", "")
        val reply = StringBuilder()
        sendButton.text = "Stop"
        statusLabel.text = " "
        session.send(text, info.ref, object : ChatListener {
            override fun onDelta(text: String) {
                reply.append(text)
                deltaArea.text = "assistant: $reply"
                refreshMessages()
            }

            override fun onCompleted(usage: Usage?) {
                sendButton.text = "Send"
                statusLabel.text = usage?.let {
                    "tokens: ${it.promptTokens ?: "?"} in / ${it.completionTokens ?: "?"} out"
                } ?: "Done"
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

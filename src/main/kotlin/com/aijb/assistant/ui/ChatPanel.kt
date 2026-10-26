package com.aijb.assistant.ui

import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.Usage
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ChatPanel @JvmOverloads constructor(
    private val project: Project,
    internal val session: ChatSession = ChatSession.getInstance(project),
) : JPanel(BorderLayout()), Disposable {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    internal val modelCombo = JComboBox<String>()
    internal val refreshButton = JButton("Refresh")
    internal val statusLabel = JLabel(" ")
    internal val messagesPanel = MessagesContainer()
    internal val scrollPane: JScrollPane = JBScrollPane(messagesPanel)
    internal val inputArea = JBTextArea(3, 40)
    internal val sendButton = JButton("Send")

    internal class MessagesContainer : JPanel(), Scrollable {
        override fun getScrollableTracksViewportWidth() = true
        override fun getScrollableTracksViewportHeight() = false
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableUnitIncrement(visibleRect: Rectangle?, orientation: Int, direction: Int) = 16
        override fun getScrollableBlockIncrement(visibleRect: Rectangle?, orientation: Int, direction: Int) = 100
    }

    init {
        messagesPanel.layout = BoxLayout(messagesPanel, BoxLayout.Y_AXIS)

        val header = JPanel(BorderLayout())
        header.border = JBUI.Borders.empty(4)
        header.add(modelCombo, BorderLayout.CENTER)
        header.add(refreshButton, BorderLayout.EAST)

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
        renderTranscript()
        loadModels()
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
        val model = modelCombo.selectedItem as? String
        if (model == null) {
            statusLabel.text = "No model selected"
            return
        }
        inputArea.text = ""
        addMessage("user", text)
        val deltaArea = addMessage("assistant", "")
        val reply = StringBuilder()
        sendButton.text = "Stop"
        statusLabel.text = " "
        session.send(text, model, object : ChatListener {
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
        val previous = modelCombo.selectedItem as? String
        statusLabel.text = "Loading models..."
        scope.launch {
            try {
                val models = session.provider.listModels()
                withContext(Dispatchers.EDT) { showModels(models, null, previous) }
            } catch (e: Exception) {
                withContext(Dispatchers.EDT) { showModels(emptyList(), e.message ?: "error", previous) }
            }
        }
    }

    private fun showModels(models: List<ModelInfo>, error: String?, previous: String?) {
        modelCombo.removeAllItems()
        models.forEach { modelCombo.addItem(it.ref.modelId) }
        if (previous != null && models.any { it.ref.modelId == previous }) {
            modelCombo.selectedItem = previous
        }
        statusLabel.text = when {
            error != null -> "Ollama unreachable: $error"
            models.isEmpty() -> "No models found"
            else -> " "
        }
    }

    override fun dispose() {
        session.cancel()
        scope.cancel()
    }
}

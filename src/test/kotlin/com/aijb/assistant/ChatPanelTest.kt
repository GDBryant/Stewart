package com.aijb.assistant

import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.chat.ContextCompactor
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.ui.ChatPanel
import com.aijb.assistant.ui.RolesPanel
import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.event.KeyEvent
import javax.swing.SwingUtilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.suspendCancellableCoroutine

class ChatPanelTest : BasePlatformTestCase() {

    private lateinit var scope: CoroutineScope
    private lateinit var session: ChatSession

    override fun setUp() {
        super.setUp()
        scope = CoroutineScope(SupervisorJob())
        session = ChatSession(project, scope).also {
            it.tools = { com.aijb.assistant.tools.ToolRegistry(emptyList()) }
        }
        AijbSettings.getInstance().loadState(AijbSettings.State())
    }

    override fun tearDown() {
        try {
            AijbSettings.getInstance().loadState(AijbSettings.State())
            scope.cancel()
        } finally {
            super.tearDown()
        }
    }

    private fun fakeProvider(
        id: String = "fake",
        models: List<String> = listOf("m1", "m2"),
        events: Flow<ProviderEvent>? = null,
    ) = object : ModelProvider {
        override val id = id
        override suspend fun listModels(): List<ModelInfo> =
            models.map { ModelInfo(ModelRef(id, it), it) }
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = events ?: flow {
            emit(ProviderEvent.TextDelta("hi"))
            emit(ProviderEvent.Completed("stop", Usage(1, 1)))
        }
    }

    private fun hangingProvider(models: List<String> = listOf("m1")) = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> =
            models.map { ModelInfo(ModelRef(id, it), it) }
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            emit(ProviderEvent.TextDelta("partial"))
            suspendCancellableCoroutine<Unit> { }
        }
    }

    private fun failingProvider() = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            emit(ProviderEvent.Failed("boom"))
        }
    }

    private fun unreachableProvider(id: String = "fake") = object : ModelProvider {
        override val id = id
        override suspend fun listModels(): List<ModelInfo> = throw java.io.IOException("refused")
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow { }
    }

    private fun pumpUntil(timeoutMs: Long = 10_000, cond: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (cond()) return true
            Thread.sleep(20)
        }
        return false
    }

    private fun pump() {
        pumpUntil(300) { false }
    }

    private fun newPanel(vararg providers: ModelProvider): ChatPanel {
        session.providers = { providers.toList() }
        val panel = ChatPanel(project, session)
        assertTrue(pumpUntil { panel.statusLabel.text != "Loading models..." })
        return panel
    }

    private fun modelIds(panel: ChatPanel): List<String> =
        (0 until panel.modelCombo.itemCount).map { panel.modelCombo.getItemAt(it).ref.modelId }

    private fun selectModel(panel: ChatPanel, providerId: String, modelId: String) {
        val idx = (0 until panel.modelCombo.itemCount).first {
            val item = panel.modelCombo.getItemAt(it)
            item.ref.providerId == providerId && item.ref.modelId == modelId
        }
        panel.modelCombo.selectedIndex = idx
    }

    fun `test models load into combo`() {
        val panel = newPanel(fakeProvider())
        assertEquals(2, panel.modelCombo.itemCount)
        assertEquals("m1", panel.modelCombo.getItemAt(0).ref.modelId)
        assertEquals(" ", panel.statusLabel.text)
    }

    fun `test load error shows unavailable`() {
        val panel = newPanel(unreachableProvider())
        assertEquals("fake unavailable: refused", panel.statusLabel.text)
        assertEquals(0, panel.modelCombo.itemCount)
    }

    fun `test selection preserved on refresh`() {
        val panel = newPanel(fakeProvider())
        selectModel(panel, "fake", "m2")
        panel.loadModels()
        assertTrue(pumpUntil { panel.statusLabel.text != "Loading models..." })
        assertEquals("m2", (panel.modelCombo.selectedItem as ModelInfo).ref.modelId)
    }

    fun `test send streams and toggles button`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "hello"
        panel.sendButton.doClick()
        pump()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" })
        val texts = panel.messageAreas().map { it.text }
        assertEquals("user: hello", texts[0])
        assertEquals("assistant: hi", texts[1])
        assertTrue(panel.statusLabel.text.startsWith("tokens:"))
        assertEquals("", panel.inputArea.text)
    }

    fun `test stop cancels job and shows cancelled`() {
        val panel = newPanel(hangingProvider())
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Stop" })
        assertTrue(pumpUntil { panel.messageAreas().last().text.contains("partial") })
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })
        assertEquals("Send", panel.sendButton.text)
        // The user turn plus a cancel marker: the interruption is part of the history.
        assertEquals(2, session.transcript.size)
        assertTrue(session.transcript.last().content.endsWith(ChatSession.CANCEL_MARKER))
        assertTrue(panel.messageAreas().last().text.startsWith("assistant: partial"))
    }

    fun `test stop right after send resets the button`() {
        val panel = newPanel(hangingProvider())
        repeat(10) {
            panel.inputArea.text = "go"
            panel.sendButton.doClick()
            assertEquals("Stop", panel.sendButton.text)
            panel.sendButton.doClick()
            assertTrue(pumpUntil { panel.sendButton.text == "Send" && panel.statusLabel.text == "Cancelled" })
        }
        assertTrue(session.transcript.last().content.endsWith(ChatSession.CANCEL_MARKER))
    }

    fun `test failure shows failed status`() {
        val panel = newPanel(failingProvider())
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Failed: boom" })
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test empty input does nothing`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "   "
        panel.sendButton.doClick()
        pump()
        assertTrue(panel.messageAreas().isEmpty())
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test no model shows message`() {
        val panel = newPanel(fakeProvider(models = emptyList()))
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        pump()
        assertEquals("No model selected", panel.statusLabel.text)
        assertTrue(panel.messageAreas().isEmpty())
    }

    fun `test enter sends shift enter does not`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "hi"
        val shiftEnter = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
            KeyEvent.SHIFT_DOWN_MASK, KeyEvent.VK_ENTER, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(shiftEnter) }
        pump()
        assertTrue(panel.messageAreas().isEmpty())
        val enter = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
            0, KeyEvent.VK_ENTER, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(enter) }
        assertTrue(pumpUntil { panel.messageAreas().isNotEmpty() })
    }

    fun `test dispose cancels active job`() {
        val panel = newPanel(hangingProvider())
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Stop" })
        panel.dispose()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })
    }

    fun `test usage with nulls shows question marks`() {
        val nullUsageProvider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                emit(ProviderEvent.Completed("stop", Usage(null, null)))
            }
        }
        val panel = newPanel(nullUsageProvider)
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "tokens: ? in / ? out · cost n/a" })
    }

    fun `test completed without usage shows done`() {
        val noUsageProvider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                emit(ProviderEvent.Completed("stop", null))
            }
        }
        val panel = newPanel(noUsageProvider)
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Done" })
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test messages container scrollable contract`() {
        val panel = newPanel(fakeProvider())
        val container = panel.messagesPanel
        assertTrue(container.scrollableTracksViewportWidth)
        assertFalse(container.scrollableTracksViewportHeight)
        assertTrue(container.preferredScrollableViewportSize.width >= 0)
        assertTrue(container.getScrollableUnitIncrement(null, 0, 1) > 0)
        assertTrue(container.getScrollableBlockIncrement(null, 0, 1) > 0)
    }

    fun `test refresh after selection removed picks nothing`() {
        val panel = newPanel(fakeProvider())
        selectModel(panel, "fake", "m2")
        session.providers = { listOf(fakeProvider(models = listOf("other"))) }
        panel.loadModels()
        assertTrue(pumpUntil { panel.statusLabel.text != "Loading models..." })
        assertEquals(1, panel.modelCombo.itemCount)
        assertEquals("other", panel.modelCombo.getItemAt(0).ref.modelId)
    }

    fun `test non enter key does nothing`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "hi"
        val a = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
            0, KeyEvent.VK_A, 'a',
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(a) }
        pump()
        assertTrue(panel.messageAreas().isEmpty())
    }

    fun `test load error without message shows generic`() {
        val provider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = throw RuntimeException()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow { }
        }
        val panel = newPanel(provider)
        assertEquals("fake unavailable: error", panel.statusLabel.text)
    }

    fun `test no models found status`() {
        val panel = newPanel(fakeProvider(models = emptyList()))
        assertEquals("No models found", panel.statusLabel.text)
    }

    fun `test models from all providers listed`() {
        val panel = newPanel(
            fakeProvider(id = "ollama", models = listOf("llama3")),
            fakeProvider(id = "claude", models = listOf("sonnet")),
        )
        assertEquals(listOf("llama3", "sonnet"), modelIds(panel))
        assertEquals("ollama", panel.modelCombo.getItemAt(0).ref.providerId)
        assertEquals("claude", panel.modelCombo.getItemAt(1).ref.providerId)
        assertEquals(" ", panel.statusLabel.text)
    }

    fun `test one failing provider does not hide others`() {
        val panel = newPanel(
            unreachableProvider(id = "ollama"),
            fakeProvider(id = "claude", models = listOf("sonnet")),
        )
        assertEquals(listOf("sonnet"), modelIds(panel))
        assertEquals("ollama unavailable: refused", panel.statusLabel.text)
    }

    fun `test send routes to selected provider`() {
        val used = mutableListOf<String>()
        fun recording(id: String) = object : ModelProvider {
            override val id = id
            override suspend fun listModels(): List<ModelInfo> =
                listOf(ModelInfo(ModelRef(id, "m-$id"), "m-$id"))
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                used += id
                emit(ProviderEvent.Completed("stop", null))
            }
        }
        val panel = newPanel(recording("p1"), recording("p2"))
        selectModel(panel, "p2", "m-p2")
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { used.isNotEmpty() })
        assertEquals(listOf("p2"), used)
    }

    fun `test send with unknown provider reports failure`() {
        val panel = newPanel(fakeProvider(id = "claude", models = listOf("sonnet")))
        panel.modelCombo.removeAllItems()
        panel.modelCombo.addItem(ModelInfo(ModelRef("ghost", "g"), "g"))
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Failed: Provider not configured: ghost" })
    }

    fun `test selection persisted and restored in new panel`() {
        val panel = newPanel(fakeProvider(id = "claude", models = listOf("sonnet", "opus")))
        selectModel(panel, "claude", "opus")
        assertEquals("claude/opus", AijbSettings.getInstance().state.chatModel)
        val panel2 = ChatPanel(project, session)
        assertTrue(pumpUntil { panel2.statusLabel.text != "Loading models..." })
        assertEquals("opus", (panel2.modelCombo.selectedItem as ModelInfo).ref.modelId)
    }

    fun `test multi model selection also sets planner`() {
        val settings = AijbSettings.getInstance()
        settings.state.multiModel = true
        val panel = newPanel(fakeProvider(id = "aif", models = listOf("m1", "m2")))
        selectModel(panel, "aif", "m2")
        assertEquals("aif/m2", settings.state.chatModel)
        assertEquals("aif/m2", settings.state.plannerModel)
    }

    fun `test settings topic publish triggers reload`() {
        val panel = newPanel(fakeProvider(models = listOf("old")))
        assertEquals(listOf("old"), modelIds(panel))
        session.providers = { listOf(fakeProvider(models = listOf("new"))) }
        ApplicationManager.getApplication().messageBus
            .syncPublisher(AijbSettings.TOPIC).settingsChanged()
        assertTrue(pumpUntil { modelIds(panel) == listOf("new") })
    }

    private fun summaryAware(
        summaryEvents: List<ProviderEvent>,
        mainEvents: List<ProviderEvent>,
    ) = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> =
            listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            val isSummary = request.messages.any {
                it.role == Role.SYSTEM && it.content == ContextCompactor.SUMMARY_PROMPT
            }
            return flow { (if (isSummary) summaryEvents else mainEvents).forEach { emit(it) } }
        }
    }

    private fun seedTranscript() {
        val provider = fakeProvider(events = flow {
            emit(ProviderEvent.TextDelta("a".repeat(40)))
            emit(ProviderEvent.Completed("stop", Usage(1, 1)))
        })
        session.providers = { listOf(provider) }
        session.autoCompactTokens = { 100_000 }
        repeat(6) {
            val done = java.util.concurrent.CountDownLatch(1)
            session.send("q$it " + "x".repeat(40), ModelRef("fake", "m1"), object : com.aijb.assistant.chat.ChatListener {
                override fun onDelta(text: String) {}
                override fun onCompleted(usage: Usage?) { done.countDown() }
                override fun onFailed(message: String) { done.countDown() }
                override fun onCancelled() { done.countDown() }
            })
            pumpUntil { done.count == 0L }
        }
    }

    fun `test compacted status suffix`() {
        seedTranscript()
        session.autoCompactTokens = { 1 }
        val panel = newPanel(summaryAware(
            listOf(ProviderEvent.TextDelta("- s"), ProviderEvent.Completed("stop", null)),
            listOf(ProviderEvent.Completed("stop", null)),
        ))
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Done · context compacted" })
    }

    fun `test compaction failed status suffix`() {
        seedTranscript()
        session.autoCompactTokens = { 1 }
        val panel = newPanel(summaryAware(
            listOf(ProviderEvent.Failed("nope")),
            listOf(ProviderEvent.Completed("stop", null)),
        ))
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Done · compaction failed" })
    }

    fun `test tool call renders area and outcome`() {
        val tool = object : com.aijb.assistant.tools.Tool {
            override val spec = com.aijb.assistant.provider.ToolSpec("t", "d", kotlinx.serialization.json.JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: kotlinx.serialization.json.JsonObject, preview: com.aijb.assistant.tools.ToolPreview?): String = "TOOL-OUT"
        }
        session.tools = { com.aijb.assistant.tools.ToolRegistry(listOf(tool)) }
        val provider = object : ModelProvider {
            override val id = "fake"
            var calls = 0
            override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
            override fun chat(request: ChatRequest): Flow<ProviderEvent> {
                return flow {
                    if (calls++ == 0) {
                        emit(ProviderEvent.NativeToolCalls(listOf(
                            com.aijb.assistant.provider.RawToolCall("c1", "t", "{}"))))
                        emit(ProviderEvent.Completed("tool_calls", null))
                    } else {
                        emit(ProviderEvent.TextDelta("final answer"))
                        emit(ProviderEvent.Completed("stop", null))
                    }
                }
            }
        }
        val panel = newPanel(provider)
        panel.inputArea.text = "hi"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Done" })
        val texts = panel.messageAreas().map { it.text }
        assertTrue(texts.any { it.startsWith("tool: t") && it.contains("TOOL-OUT") })
        assertEquals("assistant: final answer", texts.last())
    }

    fun `test roles button builds roles panel`() {
        val panel = newPanel(fakeProvider())
        assertEquals("Roles", panel.rolesButton.text)
        val roles = RolesPanel(panel.lastModels, AijbSettings.getInstance())
        assertNotNull(roles.multiModelCheck)
    }

    // --- M8 ---

    private fun failingWith(message: String, code: String?) = fakeProvider(events = flow {
        emit(ProviderEvent.Failed(message, code = code))
    })

    fun `test failure with a known code shows an error bubble with a hint`() {
        val panel = newPanel(failingWith("cannot start", "cli_not_found"))
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Failed: cannot start" })
        val error = panel.messageAreas().last().text
        assertTrue(error, error.startsWith("error: cannot start"))
        assertTrue(error, error.contains("Settings"))
    }

    fun `test failure with an unknown code adds no bubble`() {
        val panel = newPanel(failingWith("odd", "mystery"))
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Failed: odd" })
        assertTrue(panel.messageAreas().none { it.text.startsWith("error:") })
    }

    fun `test status shows session totals after a second request`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "one"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && panel.statusLabel.text.startsWith("tokens:") })
        assertEquals("tokens: 1 in / 1 out · cost n/a", panel.statusLabel.text)
        panel.inputArea.text = "two"
        panel.sendButton.doClick()
        assertTrue(pumpUntil {
            panel.statusLabel.text == "tokens: 1 in / 1 out · cost n/a · session: 2 in / 2 out · cost n/a"
        })
    }

    fun `test clear button wipes chat usage and status`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "one"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && panel.statusLabel.text.startsWith("tokens:") })
        assertTrue(panel.messageAreas().isNotEmpty())
        panel.clearButton.doClick()
        assertTrue(panel.messageAreas().isEmpty())
        assertTrue(session.transcript.isEmpty())
        assertNull(session.sessionUsage)
        assertEquals("History cleared", panel.statusLabel.text)
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test cancel with an uncertain tool outcome says so`() {
        val inTool = java.util.concurrent.CountDownLatch(1)
        session.tools = { com.aijb.assistant.tools.ToolRegistry(listOf(object : com.aijb.assistant.tools.Tool {
            override val spec = com.aijb.assistant.provider.ToolSpec("t", "d", kotlinx.serialization.json.JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: kotlinx.serialization.json.JsonObject, preview: com.aijb.assistant.tools.ToolPreview?): String {
                inTool.countDown()
                kotlinx.coroutines.awaitCancellation()
            }
        })) }
        val provider = fakeProvider(events = flow {
            emit(ProviderEvent.NativeToolCalls(listOf(com.aijb.assistant.provider.RawToolCall("c1", "t", "{}"))))
            emit(ProviderEvent.Completed("tool_calls", null))
        })
        val panel = newPanel(provider)
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { inTool.count == 0L })
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text.startsWith("Cancelled") })
        assertEquals(
            "Cancelled · 1 tool outcome(s) uncertain, side effects not rolled back",
            panel.statusLabel.text,
        )
    }

    private fun askingProvider() = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
        override fun chat(request: ChatRequest): Flow<ProviderEvent> {
            val sys = request.messages.firstOrNull { it.role == Role.SYSTEM }?.content.orEmpty()
            val answered = request.messages.any { it.content.contains("use pg") }
            val (name, args) = when {
                sys.contains("submit_plan") && !answered ->
                    "ask_user" to """{"question":"Which db?","options":["use pg","use mysql"]}"""
                sys.contains("submit_plan") ->
                    "submit_plan" to """{"goal":"g","milestones":[{"id":1,"title":"m1","notes":"n"}]}"""
                else -> "complete_milestone" to """{"notes":"ok"}"""
            }
            return flow {
                emit(ProviderEvent.NativeToolCalls(listOf(com.aijb.assistant.provider.RawToolCall("c-$name", name, args))))
                emit(ProviderEvent.Completed("tool_calls", Usage(1, 1)))
            }
        }
    }

    fun `test planner question shows inline and an option button answers it`() {
        settings(multi = true)
        val panel = newPanel(askingProvider())
        panel.inputArea.text = "build"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.questionPanel != null })
        assertEquals("Stop", panel.sendButton.text)
        assertEquals(listOf("use pg", "use mysql"), panel.questionButtons.map { it.text })
        assertEquals("Waiting for your answer", panel.statusLabel.text)
        panel.questionButtons[0].doClick()
        assertNull(panel.questionPanel)
        assertTrue(panel.messageAreas().any { it.text == "user: use pg" })
        assertTrue(pumpUntil { panel.sendButton.text == "Send" })
    }

    fun `test typed answer is submitted and a blank one is ignored`() {
        settings(multi = true)
        val panel = newPanel(askingProvider())
        panel.inputArea.text = "build"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.questionPanel != null })
        panel.questionField!!.text = "   "
        panel.questionAnswerButton!!.doClick()
        assertNotNull(panel.questionPanel)
        panel.questionField!!.text = "use pg please"
        panel.questionAnswerButton!!.doClick()
        assertNull(panel.questionPanel)
        assertTrue(panel.messageAreas().any { it.text == "user: use pg please" })
    }

    fun `test stop while a question is open removes it and cancels`() {
        settings(multi = true)
        val panel = newPanel(askingProvider())
        panel.inputArea.text = "build"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.questionPanel != null })
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })
        assertNull(panel.questionPanel)
        assertEquals("Send", panel.sendButton.text)
    }

    private fun enter(panel: ChatPanel) {
        val enter = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(enter) }
    }

    fun `test help command shows output locally and sends nothing`() {
        var requests = 0
        val panel = newPanel(fakeProvider(events = flow { requests++ }))
        panel.inputArea.text = "/help"
        panel.sendButton.doClick()
        pump()
        assertEquals(0, requests)
        assertTrue(session.transcript.isEmpty())
        assertTrue(panel.messageAreas().single().text.startsWith("system: Commands:"))
        assertEquals("", panel.inputArea.text)
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test help works without a model selected`() {
        val panel = newPanel(fakeProvider(models = emptyList()))
        panel.inputArea.text = "/help"
        enter(panel)
        assertTrue(panel.messageAreas().single().text.startsWith("system: Commands:"))
    }

    fun `test unknown command shows an error and keeps the input`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/nope"
        panel.sendButton.doClick()
        pump()
        assertEquals("error: Unknown command /nope — type /help", panel.messageAreas().single().text)
        assertEquals("/nope", panel.inputArea.text)
        assertTrue(session.transcript.isEmpty())
    }

    fun `test double slash is sent as plain text without the escape`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "//etc/hosts"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && session.transcript.size == 2 })
        assertEquals("/etc/hosts", session.transcript[0].content)
    }

    fun `test leading space slash is plain text`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = " /help"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && session.transcript.size == 2 })
        assertEquals("/help", session.transcript[0].content)
    }

    fun `test enter while running runs help and ignores plain text`() {
        val panel = newPanel(hangingProvider())
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.messageAreas().last().text.contains("partial") })
        panel.inputArea.text = "more"
        enter(panel)
        pump()
        assertEquals("Stop", panel.sendButton.text)
        assertEquals("more", panel.inputArea.text)
        panel.inputArea.text = "/help"
        enter(panel)
        assertEquals("Stop", panel.sendButton.text)
        assertTrue(panel.messageAreas().last().text.startsWith("system: Commands:"))
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })
    }

    fun `test clear command wipes the chat`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "one"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && session.transcript.size == 2 })
        panel.inputArea.text = "/clear"
        enter(panel)
        assertTrue(session.transcript.isEmpty())
        assertTrue(panel.messageAreas().isEmpty())
        assertEquals("History cleared", panel.statusLabel.text)
    }

    fun `test cost command shows session usage and runs while running`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/cost"
        enter(panel)
        assertEquals("system: No usage yet", panel.messageAreas().last().text)
        panel.inputArea.text = "one"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && panel.statusLabel.text.startsWith("tokens:") })
        panel.inputArea.text = "/cost"
        enter(panel)
        assertEquals("system: Session: tokens 1 in / 1 out · cost n/a", panel.messageAreas().last().text)
    }

    fun `test commands other than help and cost are blocked while running`() {
        var opened = 0
        val panel = newPanel(hangingProvider())
        panel.openSettingsPage = { opened++ }
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.messageAreas().last().text.contains("partial") })
        for (cmd in listOf("/clear", "/config", "/model m1")) {
            panel.inputArea.text = cmd
            enter(panel)
            assertEquals("error: ${cmd.substringBefore(' ')} is not available while running", panel.messageAreas().last().text)
            assertEquals(cmd, panel.inputArea.text)
        }
        assertEquals(0, opened)
        assertEquals("Stop", panel.sendButton.text)
        panel.inputArea.text = "/cost"
        enter(panel)
        assertEquals("system: No usage yet", panel.messageAreas().last().text)
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })
    }

    fun `test config command opens the settings page`() {
        var opened = 0
        val panel = newPanel(fakeProvider(models = emptyList()))
        panel.openSettingsPage = { opened++ }
        panel.inputArea.text = "/config"
        enter(panel)
        assertEquals(1, opened)
        assertEquals("", panel.inputArea.text)
    }

    fun `test model command switches and persists the selection`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/model fake/m2"
        enter(panel)
        assertEquals("m2", (panel.modelCombo.selectedItem as ModelInfo).ref.modelId)
        assertEquals("fake/m2", AijbSettings.getInstance().state.chatModel)
        assertEquals("system: Model: fake/m2", panel.messageAreas().last().text)
        panel.inputArea.text = "/model"
        enter(panel)
        assertEquals("system: Model: fake/m2", panel.messageAreas().last().text)
    }

    fun `test model command with an unknown model keeps the selection`() {
        val panel = newPanel(fakeProvider())
        selectModel(panel, "fake", "m1")
        panel.inputArea.text = "/model zz"
        enter(panel)
        assertEquals("m1", (panel.modelCombo.selectedItem as ModelInfo).ref.modelId)
        assertEquals("error: Unknown model zz. Available: fake/m1, fake/m2", panel.messageAreas().last().text)
        assertEquals("/model zz", panel.inputArea.text)
    }

    private fun settings(multi: Boolean) {
        AijbSettings.getInstance().state.multiModel = multi
    }
}

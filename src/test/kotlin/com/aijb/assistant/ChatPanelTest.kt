package com.aijb.assistant

import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
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
        session = ChatSession(project, scope)
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
        assertEquals(1, session.transcript.size)
        assertTrue(panel.messageAreas().last().text.startsWith("assistant: partial"))
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
        assertTrue(pumpUntil { panel.statusLabel.text == "tokens: ? in / ? out" })
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

    fun `test roles button builds roles panel`() {
        val panel = newPanel(fakeProvider())
        assertEquals("Roles", panel.rolesButton.text)
        val roles = RolesPanel(panel.lastModels, AijbSettings.getInstance())
        assertNotNull(roles.multiModelCheck)
    }
}

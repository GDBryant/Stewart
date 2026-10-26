package com.aijb.assistant

import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.ui.ChatPanel
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.event.KeyEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.swing.SwingUtilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
    }

    override fun tearDown() {
        try {
            scope.cancel()
        } finally {
            super.tearDown()
        }
    }

    private fun fakeProvider(
        models: List<String> = listOf("m1", "m2"),
        events: Flow<ProviderEvent>? = null,
    ) = object : ModelProvider {
        override val id = "fake"
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

    private fun unreachableProvider() = object : ModelProvider {
        override val id = "fake"
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

    private fun newPanel(provider: ModelProvider): ChatPanel {
        session.provider = provider
        val panel = ChatPanel(project, session)
        assertTrue(pumpUntil { panel.statusLabel.text != "Loading models..." })
        return panel
    }

    fun `test models load into combo`() {
        val panel = newPanel(fakeProvider())
        assertEquals(2, panel.modelCombo.itemCount)
        assertEquals("m1", panel.modelCombo.getItemAt(0))
        assertEquals(" ", panel.statusLabel.text)
    }

    fun `test load error shows unreachable`() {
        val panel = newPanel(unreachableProvider())
        assertTrue(panel.statusLabel.text.startsWith("Ollama unreachable"))
        assertEquals(0, panel.modelCombo.itemCount)
    }

    fun `test selection preserved on refresh`() {
        val panel = newPanel(fakeProvider())
        panel.modelCombo.selectedItem = "m2"
        panel.loadModels()
        assertTrue(pumpUntil { panel.statusLabel.text != "Loading models..." })
        assertEquals("m2", panel.modelCombo.selectedItem)
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
        panel.modelCombo.selectedItem = "m2"
        session.provider = fakeProvider(models = listOf("other"))
        panel.loadModels()
        assertTrue(pumpUntil { panel.statusLabel.text != "Loading models..." })
        assertEquals(1, panel.modelCombo.itemCount)
        assertEquals("other", panel.modelCombo.getItemAt(0))
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
        assertEquals("Ollama unreachable: error", panel.statusLabel.text)
    }

    fun `test no models found status`() {
        val panel = newPanel(fakeProvider(models = emptyList()))
        assertEquals("No models found", panel.statusLabel.text)
    }
}

package com.adb.stewart

import com.adb.stewart.chat.ChatSession
import com.adb.stewart.chat.ContextCompactor
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.Usage
import com.adb.stewart.settings.StewartSettings
import com.adb.stewart.tools.permissions.ApprovalCategory
import com.adb.stewart.tools.permissions.ProjectPermissions
import com.adb.stewart.ui.ChatPanel
import com.adb.stewart.ui.RolesPanel
import com.intellij.openapi.application.ApplicationManager
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.BorderLayout
import java.awt.event.KeyEvent
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JPanel
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
            it.tools = { com.adb.stewart.tools.ToolRegistry(emptyList()) }
        }
        StewartSettings.getInstance().loadState(StewartSettings.State())
        ProjectPermissions.getInstance().resetForTest()
    }

    override fun tearDown() {
        try {
            StewartSettings.getInstance().loadState(StewartSettings.State())
            ProjectPermissions.getInstance().resetForTest()
            com.adb.stewart.debug.DebugLogSink.configure(false, "./log/debug_logs/")
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

    private fun checkbox(panel: javax.swing.JPanel, text: String): JCheckBox =
        panel.components.filterIsInstance<JCheckBox>().first { it.text.contains(text, true) }

    fun `test bypass tick writes through to project permissions`() {
        val panel = newPanel(fakeProvider())
        val p = panel.bypassPanel()
        val edits = checkbox(p, "edits")
        edits.isSelected = true
        edits.actionListeners.forEach { it.actionPerformed(null) }
        assertTrue(
            ProjectPermissions.getInstance().forProject(project).covers(ApprovalCategory.EDITS),
        )
        assertTrue(pumpUntil { panel.bypassLabel.text == "bypass: edits" })
    }

    fun `test enabling commands asks for confirmation and cancel leaves tick off`() {
        val panel = newPanel(fakeProvider())
        panel.confirmBypass = { false }
        val p = panel.bypassPanel()
        val cmds = checkbox(p, "commands")
        cmds.isSelected = true
        cmds.actionListeners.forEach { it.actionPerformed(null) }
        assertFalse(
            ProjectPermissions.getInstance().forProject(project).covers(ApprovalCategory.COMMANDS),
        )

        panel.confirmBypass = { true }
        cmds.isSelected = true
        cmds.actionListeners.forEach { it.actionPerformed(null) }
        assertTrue(
            ProjectPermissions.getInstance().forProject(project).covers(ApprovalCategory.COMMANDS),
        )
    }

    fun `test clear chat grants empties the indicator`() {
        val panel = newPanel(fakeProvider())
        session.sessionGrants.grant(ApprovalCategory.EDITS)
        panel.refreshBypassState()
        assertEquals("bypass: edits", panel.bypassLabel.text)
        panel.clearChatGrants()
        assertEquals(" ", panel.bypassLabel.text)
        assertEquals("Bypass", panel.bypassButton.text)
    }

    fun `test program grants show as plus count`() {
        val panel = newPanel(fakeProvider())
        session.sessionGrants.grant(listOf("git", "grep"))
        panel.refreshBypassState()
        assertEquals("bypass: +2", panel.bypassLabel.text)
        assertEquals("Bypass: +2", panel.bypassButton.text)
    }

    fun `test manage opens the permissions page`() {
        val panel = newPanel(fakeProvider())
        var opened = false
        panel.openPermissionsPage = { opened = true }
        val p = panel.bypassPanel()
        p.components.filterIsInstance<JButton>().first { it.text.startsWith("Manage") }
            .actionListeners.forEach { it.actionPerformed(null) }
        assertTrue(opened)
    }

    fun `test successful tool output is collapsed by default`() {
        val panel = newPanel(fakeProvider())
        val row = panel.addToolRowForTest("RunTerminal", "{}", com.adb.stewart.tools.ToolOutcome.Success("a\nb"))
        assertFalse(row.bodyVisible)
        assertEquals("▸ tool: RunTerminal {} · ✓", row.headerText)
        row.toggle(); assertTrue(row.bodyVisible)
        assertTrue(row.headerText.startsWith("▾"))
        row.toggle(); assertFalse(row.bodyVisible)
    }

    fun `test non-success tool outcomes are expanded`() {
        val panel = newPanel(fakeProvider())
        for ((outcome, word) in listOf<Pair<com.adb.stewart.tools.ToolOutcome, String>>(
            com.adb.stewart.tools.ToolOutcome.Failure("boom") to "Failed", com.adb.stewart.tools.ToolOutcome.Rejected("no") to "Rejected",
            com.adb.stewart.tools.ToolOutcome.Invalid("bad") to "Invalid", com.adb.stewart.tools.ToolOutcome.Uncertain("hm") to "Uncertain",
        )) {
            val row = panel.addToolRowForTest("RunTerminal", "{}", outcome)
            assertTrue(word, row.bodyVisible)
            assertTrue(row.headerText.endsWith(word))
        }
    }

    fun `test tool body is capped`() {
        val panel = newPanel(fakeProvider())
        val row = panel.addToolRowForTest("T", "{}",
            com.adb.stewart.tools.ToolOutcome.Success("x".repeat(2500)))
        assertEquals(2000, row.body.text.length)
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

    fun `test user message is right aligned and tinted`() {
        val panel = newPanel(fakeProvider())
        panel.addMessage("user", "hi")
        panel.addMessage("assistant", "yo")
        val (user, assistant) = panel.messageAreas()
        assertEquals("hi", user.text)
        assertEquals("assistant: yo", assistant.text)
        val userRow = user.parent as JPanel
        assertSame(user, (userRow.layout as BorderLayout).getLayoutComponent(BorderLayout.EAST))
        assertFalse(user.background == assistant.background)
    }

    fun `test non user messages keep prefix, centered and untinted`() {
        val panel = newPanel(fakeProvider())
        panel.addMessage("system", "a")
        panel.addMessage("error", "b")
        val areas = panel.messageAreas()
        assertEquals(listOf("system: a", "error: b"), areas.map { it.text })
        areas.forEach {
            val layout = (it.parent as JPanel).layout as BorderLayout
            assertSame(it, layout.getLayoutComponent(BorderLayout.CENTER))
            assertNull(layout.getLayoutComponent(BorderLayout.EAST))
            assertEquals(com.intellij.util.ui.UIUtil.getPanelBackground(), it.background)
        }
    }

    fun `test send streams and toggles button`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "hello"
        panel.sendButton.doClick()
        pump()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" })
        val texts = panel.messageAreas().map { it.text }
        assertEquals("hello", texts[0])
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

    fun `test shift enter inserts newline without sending`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "hi"
        val shiftEnter = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
            KeyEvent.SHIFT_DOWN_MASK, KeyEvent.VK_ENTER, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(shiftEnter) }
        val typed = KeyEvent(
            panel.inputArea, KeyEvent.KEY_TYPED, System.currentTimeMillis(),
            KeyEvent.SHIFT_DOWN_MASK, KeyEvent.VK_UNDEFINED, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyTyped(typed) }
        assertEquals("hi\n", panel.inputArea.text)
        assertTrue(typed.isConsumed)
        pump()
        assertTrue(panel.messageAreas().isEmpty())
    }

    fun `test plain enter typed newline is swallowed`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "hi"
        val enter = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
            0, KeyEvent.VK_ENTER, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(enter) }
        val typed = KeyEvent(
            panel.inputArea, KeyEvent.KEY_TYPED, System.currentTimeMillis(),
            0, KeyEvent.VK_UNDEFINED, '\n',
        )
        panel.inputArea.keyListeners.forEach { it.keyTyped(typed) }
        assertTrue(typed.isConsumed)
        assertTrue(pumpUntil { panel.messageAreas().isNotEmpty() })
    }

    fun `test panel applies debug log settings to the sink`() {
        StewartSettings.getInstance().state.debugLogEnabled = true
        StewartSettings.getInstance().state.debugLogFolder = "/tmp/stewart-panel-debug"
        StewartSettings.getInstance().state.debugLogRetentionDays = 12
        newPanel(fakeProvider())
        assertTrue(com.adb.stewart.debug.DebugLogSink.isEnabled)
        assertEquals("/tmp/stewart-panel-debug", com.adb.stewart.debug.DebugLogSink.logDirectory)
        assertEquals(12, com.adb.stewart.debug.DebugLogSink.retentionDays)
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
        assertEquals("claude/opus", StewartSettings.getInstance().state.chatModel)
        val panel2 = ChatPanel(project, session)
        assertTrue(pumpUntil { panel2.statusLabel.text != "Loading models..." })
        assertEquals("opus", (panel2.modelCombo.selectedItem as ModelInfo).ref.modelId)
    }

    fun `test single mode enables main picker and never touches role models`() {
        val settings = StewartSettings.getInstance()
        val panel = newPanel(fakeProvider(id = "aif", models = listOf("m1", "m2")))
        assertTrue(panel.modelCombo.isEnabled)
        selectModel(panel, "aif", "m2")
        assertEquals("aif/m2", settings.state.chatModel)
        assertNull(settings.state.plannerModel)
        assertTrue(panel.modeLabel.text.startsWith("mode=single · effort=medium · model=aif/m2"))
    }

    fun `test multi mode disables main picker and shows role bindings`() {
        val settings = StewartSettings.getInstance()
        settings.state.multiModel = true
        settings.state.plannerModel = "aif/m1"
        val panel = newPanel(fakeProvider(id = "aif", models = listOf("m1", "m2")))
        assertFalse(panel.modelCombo.isEnabled)
        assertTrue(panel.modeLabel.text, panel.modeLabel.text.startsWith("mode=multi · effort=medium · planner→aif/m1 · executor→unset · worker→unset"))
        settings.state.multiModel = false
        panel.updateSelectorState()
        assertTrue(panel.modelCombo.isEnabled)
    }

    fun `test settings topic publish triggers reload`() {
        val panel = newPanel(fakeProvider(models = listOf("old")))
        assertEquals(listOf("old"), modelIds(panel))
        session.providers = { listOf(fakeProvider(models = listOf("new"))) }
        ApplicationManager.getApplication().messageBus
            .syncPublisher(StewartSettings.TOPIC).settingsChanged()
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
            session.send("q$it " + "x".repeat(40), ModelRef("fake", "m1"), object : com.adb.stewart.chat.ChatListener {
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
        val tool = object : com.adb.stewart.tools.Tool {
            override val spec = com.adb.stewart.provider.ToolSpec("t", "d", kotlinx.serialization.json.JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: kotlinx.serialization.json.JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String = "TOOL-OUT"
        }
        session.tools = { com.adb.stewart.tools.ToolRegistry(listOf(tool)) }
        val provider = object : ModelProvider {
            override val id = "fake"
            var calls = 0
            override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
            override fun chat(request: ChatRequest): Flow<ProviderEvent> {
                return flow {
                    if (calls++ == 0) {
                        emit(ProviderEvent.NativeToolCalls(listOf(
                            com.adb.stewart.provider.RawToolCall("c1", "t", "{}"))))
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
        assertTrue(texts.any { it.contains("TOOL-OUT") })
        assertTrue(panel.toolRows().any { it.headerText.contains("tool: t") })
        assertEquals("assistant: final answer", texts.last())
    }

    fun `test roles button builds roles panel`() {
        val panel = newPanel(fakeProvider())
        assertEquals("Roles", panel.rolesButton.text)
        val roles = RolesPanel(panel.lastModels, StewartSettings.getInstance())
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
        session.tools = { com.adb.stewart.tools.ToolRegistry(listOf(object : com.adb.stewart.tools.Tool {
            override val spec = com.adb.stewart.provider.ToolSpec("t", "d", kotlinx.serialization.json.JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: kotlinx.serialization.json.JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                inTool.countDown()
                kotlinx.coroutines.awaitCancellation()
            }
        })) }
        val provider = fakeProvider(events = flow {
            emit(ProviderEvent.NativeToolCalls(listOf(com.adb.stewart.provider.RawToolCall("c1", "t", "{}"))))
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
                emit(ProviderEvent.NativeToolCalls(listOf(com.adb.stewart.provider.RawToolCall("c-$name", name, args))))
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
        assertTrue(panel.messageAreas().any { it.text == "use pg" })
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
        assertTrue(panel.messageAreas().any { it.text == "use pg please" })
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
        assertEquals("fake/m2", StewartSettings.getInstance().state.chatModel)
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

    private fun summarizingProvider(models: List<String> = listOf("m1")) = fakeProvider(
        models = models,
        events = flow {
            emit(ProviderEvent.TextDelta("- sum"))
            emit(ProviderEvent.Completed("stop", Usage(2, 2)))
        },
    )

    fun `test compact command compacts and resets the button`() {
        val panel = newPanel(summarizingProvider())
        session.commitIfActive(null, (1..3).flatMap {
            listOf(
                com.adb.stewart.provider.ChatMessage(Role.USER, "q$it"),
                com.adb.stewart.provider.ChatMessage(Role.ASSISTANT, "a$it"),
            )
        })
        panel.inputArea.text = "/compact api"
        enter(panel)
        assertEquals("", panel.inputArea.text)
        assertTrue(pumpUntil { panel.sendButton.text == "Send" })
        assertTrue(panel.messageAreas().last().text.startsWith("system: Context compacted"))
        assertEquals("tokens: 2 in / 2 out · cost n/a", panel.statusLabel.text)
        assertTrue(session.transcript[0].content.startsWith(ContextCompactor.SUMMARY_PREFIX))
    }

    fun `test compact command with nothing to compact says so`() {
        val panel = newPanel(summarizingProvider())
        panel.inputArea.text = "/compact"
        enter(panel)
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && panel.messageAreas().isNotEmpty() })
        assertEquals("system: Nothing to compact", panel.messageAreas().last().text)
        assertEquals("Done", panel.statusLabel.text)
    }

    fun `test compact command failure and cancel reset the button`() {
        val panel = newPanel(failingProvider())
        session.commitIfActive(null, (1..3).flatMap {
            listOf(
                com.adb.stewart.provider.ChatMessage(Role.USER, "q$it"),
                com.adb.stewart.provider.ChatMessage(Role.ASSISTANT, "a$it"),
            )
        })
        panel.inputArea.text = "/compact"
        enter(panel)
        assertTrue(pumpUntil { panel.statusLabel.text == "Failed: Compaction failed: boom" })
        assertEquals("Send", panel.sendButton.text)
        session.providers = { listOf(hangingProvider()) }
        panel.inputArea.text = "/compact"
        enter(panel)
        assertEquals("Stop", panel.sendButton.text)
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test compact command without a model keeps the input`() {
        val panel = newPanel(fakeProvider(models = emptyList()))
        panel.inputArea.text = "/compact"
        enter(panel)
        assertEquals("No model selected", panel.statusLabel.text)
        assertEquals("/compact", panel.inputArea.text)
        assertEquals("Send", panel.sendButton.text)
    }

    private fun capturingProvider(seen: MutableList<String>) = fakeProvider(events = flow {
        emit(ProviderEvent.TextDelta("ok"))
        emit(ProviderEvent.Completed("stop", Usage(1, 1)))
    }).let { base ->
        object : ModelProvider by base {
            override fun chat(request: ChatRequest): Flow<ProviderEvent> {
                seen += request.messages.last { it.role == Role.USER }.content
                return base.chat(request)
            }
        }
    }

    private fun initChoice(panel: ChatPanel, option: String) {
        assertTrue(pumpUntil { panel.choicePanel != null })
        val button = com.intellij.util.ui.UIUtil.findComponentsOfType(panel.choicePanel, javax.swing.JButton::class.java)
            .single { it.text == option }
        button.doClick()
        assertTrue(pumpUntil { panel.choicePanel == null })
    }

    fun `test init command asks once and investigate sends the canned prompt`() {
        val seen = mutableListOf<String>()
        val panel = newPanel(capturingProvider(seen))
        panel.initFilesSource = { com.adb.stewart.chat.InitFiles.Result(emptyList(), emptyList()) }
        panel.inputArea.text = "/init"
        enter(panel)
        assertEquals("", panel.inputArea.text)
        initChoice(panel, com.adb.stewart.chat.SlashCommands.INIT_INVESTIGATE)
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && seen.isNotEmpty() })
        assertEquals(com.adb.stewart.chat.SlashCommands.INIT_PROMPT, seen.single())
    }

    fun `test init command stop sends nothing`() {
        val seen = mutableListOf<String>()
        val panel = newPanel(capturingProvider(seen))
        panel.initFilesSource = { com.adb.stewart.chat.InitFiles.Result(emptyList(), emptyList()) }
        panel.inputArea.text = "/init"
        enter(panel)
        initChoice(panel, com.adb.stewart.chat.SlashCommands.INIT_STOP)
        assertTrue(seen.isEmpty())
    }

    fun `test init command without a model keeps the input`() {
        val panel = newPanel(fakeProvider(models = emptyList()))
        panel.inputArea.text = "/init"
        enter(panel)
        assertEquals("No model selected", panel.statusLabel.text)
        assertEquals("/init", panel.inputArea.text)
    }

    fun `test review command sends the diff`() {
        val seen = mutableListOf<String>()
        val panel = newPanel(capturingProvider(seen))
        panel.diffSource = { com.adb.stewart.chat.GitDiff.Result.Diff("+changed line\n") }
        panel.inputArea.text = "/review naming"
        enter(panel)
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && seen.isNotEmpty() })
        assertTrue(seen.single().contains("+changed line"))
        assertTrue(seen.single().contains("Focus on: naming"))
    }

    fun `test review command with no changes sends nothing`() {
        val seen = mutableListOf<String>()
        val panel = newPanel(capturingProvider(seen))
        panel.diffSource = { com.adb.stewart.chat.GitDiff.Result.NoChanges }
        panel.inputArea.text = "/review"
        enter(panel)
        assertTrue(pumpUntil { panel.messageAreas().isNotEmpty() })
        assertEquals("system: No changes to review", panel.messageAreas().single().text)
        pump()
        assertTrue(seen.isEmpty())
        assertTrue(session.transcript.isEmpty())
    }

    fun `test review command outside a repo shows an error`() {
        val panel = newPanel(fakeProvider())
        panel.diffSource = { com.adb.stewart.chat.GitDiff.Result.NotRepo("Not a git repository") }
        panel.inputArea.text = "/review"
        enter(panel)
        assertTrue(pumpUntil { panel.messageAreas().isNotEmpty() })
        assertEquals("error: Cannot review: Not a git repository", panel.messageAreas().single().text)
    }

    fun `test review command without a model reads nothing`() {
        var reads = 0
        val panel = newPanel(fakeProvider(models = emptyList()))
        panel.diffSource = { reads++; com.adb.stewart.chat.GitDiff.Result.NoChanges }
        panel.inputArea.text = "/review"
        enter(panel)
        pump()
        assertEquals(0, reads)
        assertEquals("No model selected", panel.statusLabel.text)
    }

    fun `test review diff that arrives mid-run or after the model is gone is not sent`() {
        val gate = java.util.concurrent.CountDownLatch(1)
        val panel = newPanel(hangingProvider())
        panel.diffSource = { gate.await(); com.adb.stewart.chat.GitDiff.Result.Diff("+x\n") }
        panel.inputArea.text = "/review"
        enter(panel)
        panel.inputArea.text = "go"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.messageAreas().last().text.contains("partial") })
        gate.countDown()
        assertTrue(pumpUntil { panel.messageAreas().last().text == "error: /review is not available while running" })
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.statusLabel.text == "Cancelled" })

        val gate2 = java.util.concurrent.CountDownLatch(1)
        panel.diffSource = { gate2.await(); com.adb.stewart.chat.GitDiff.Result.Diff("+x\n") }
        panel.inputArea.text = "/review"
        enter(panel)
        panel.modelCombo.removeAllItems()
        gate2.countDown()
        assertTrue(pumpUntil { panel.statusLabel.text == "No model selected" })
        assertEquals("Send", panel.sendButton.text)
    }

    private fun key(panel: ChatPanel, code: Int, shift: Boolean = false) {
        val e = KeyEvent(
            panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
            if (shift) KeyEvent.SHIFT_DOWN_MASK else 0, code, KeyEvent.CHAR_UNDEFINED,
        )
        panel.inputArea.keyListeners.forEach { it.keyPressed(e) }
    }

    private fun names(panel: ChatPanel) = panel.completionItems.map { it.name }

    fun `test typing a slash prefix lists matching commands and a space hides them`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/co"
        assertEquals(listOf("cost", "compact", "config"), names(panel))
        panel.inputArea.text = "/cost "
        assertTrue(names(panel).isEmpty())
        panel.inputArea.text = "/zz"
        assertTrue(names(panel).isEmpty())
        panel.inputArea.text = "plain"
        assertTrue(names(panel).isEmpty())
    }

    fun `test tab inserts the selected command and swallows the tab char`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/co"
        key(panel, KeyEvent.VK_DOWN)
        key(panel, KeyEvent.VK_TAB)
        assertEquals("/compact ", panel.inputArea.text)
        assertTrue(names(panel).isEmpty())
        val typed = KeyEvent(panel.inputArea, KeyEvent.KEY_TYPED, System.currentTimeMillis(), 0, KeyEvent.VK_UNDEFINED, '\t')
        panel.inputArea.keyListeners.forEach { it.keyTyped(typed) }
        assertTrue(typed.isConsumed)
        val again = KeyEvent(panel.inputArea, KeyEvent.KEY_TYPED, System.currentTimeMillis(), 0, KeyEvent.VK_UNDEFINED, '\t')
        panel.inputArea.keyListeners.forEach { it.keyTyped(again) }
        assertFalse(again.isConsumed)
    }

    fun `test up wraps and enter on a partial name inserts it`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/co"
        key(panel, KeyEvent.VK_UP)
        assertEquals("config", panel.completionList.selectedValue.name)
        key(panel, KeyEvent.VK_ENTER)
        assertEquals("/config ", panel.inputArea.text)
        assertTrue(panel.messageAreas().isEmpty())
    }

    fun `test enter on a full command name runs it`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/help"
        assertEquals(listOf("help"), names(panel))
        enter(panel)
        assertTrue(panel.messageAreas().single().text.startsWith("system: Commands:"))
        assertEquals("", panel.inputArea.text)
    }

    fun `test escape hides completions until the text changes`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/c"
        key(panel, KeyEvent.VK_ESCAPE)
        assertTrue(names(panel).isEmpty())
        key(panel, KeyEvent.VK_TAB)
        assertEquals("/c", panel.inputArea.text)
        panel.inputArea.text = "/cl"
        assertEquals(listOf("clear"), names(panel))
    }

    fun `test other keys pass through while completions are listed`() {
        val panel = newPanel(fakeProvider())
        panel.inputArea.text = "/c"
        val e = KeyEvent(panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_A, 'a')
        assertFalse(panel.handleCompletionKey(e))
        key(panel, KeyEvent.VK_ENTER, shift = true)
        assertEquals("/c\n", panel.inputArea.text)
    }

    private fun user(text: String) = com.adb.stewart.provider.ChatMessage(Role.USER, text)

    fun `test up recalls prompts on empty input and down walks back to empty`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"), com.adb.stewart.provider.ChatMessage(Role.ASSISTANT, "r"), user("second"))
        key(panel, KeyEvent.VK_UP)
        assertEquals("second", panel.inputArea.text)
        key(panel, KeyEvent.VK_UP)
        assertEquals("first", panel.inputArea.text)
        key(panel, KeyEvent.VK_UP)
        assertEquals("first", panel.inputArea.text)
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("second", panel.inputArea.text)
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("", panel.inputArea.text)
    }

    fun `test up does not replace typed text`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"))
        panel.inputArea.text = "typing"
        key(panel, KeyEvent.VK_UP)
        assertEquals("typing", panel.inputArea.text)
    }

    fun `test editing a recalled prompt stops browsing`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"), user("second"))
        key(panel, KeyEvent.VK_UP)
        panel.inputArea.text = "second edited"
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("second edited", panel.inputArea.text)
    }

    fun `test up is ignored while the completion popup is open`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"))
        panel.inputArea.text = "/"
        assertTrue(names(panel).isNotEmpty())
        key(panel, KeyEvent.VK_UP)
        assertEquals("/", panel.inputArea.text)
    }

    fun `test up with empty history leaves input empty`() {
        val panel = newPanel(fakeProvider())
        key(panel, KeyEvent.VK_UP)
        assertEquals("", panel.inputArea.text)
    }

    fun `test down when not browsing does nothing`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"))
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("", panel.inputArea.text)
    }

    fun `test compaction summary is not recalled`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("real"), user(ContextCompactor.SUMMARY_PREFIX + "\nstuff"))
        key(panel, KeyEvent.VK_UP)
        assertEquals("real", panel.inputArea.text)
    }

    private fun modKey(panel: ChatPanel, code: Int, mods: Int) {
        val e = KeyEvent(panel.inputArea, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), mods, code, KeyEvent.CHAR_UNDEFINED)
        panel.inputArea.keyListeners.forEach { it.keyPressed(e) }
    }

    fun `test modified up does not recall`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"))
        for (m in listOf(KeyEvent.SHIFT_DOWN_MASK, KeyEvent.CTRL_DOWN_MASK, KeyEvent.ALT_DOWN_MASK)) {
            modKey(panel, KeyEvent.VK_UP, m)
            assertEquals("", panel.inputArea.text)
        }
        key(panel, KeyEvent.VK_UP)
        assertEquals("first", panel.inputArea.text)
    }

    fun `test modified down does not walk while browsing`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("first"), user("second"))
        key(panel, KeyEvent.VK_UP)
        key(panel, KeyEvent.VK_UP)
        modKey(panel, KeyEvent.VK_DOWN, KeyEvent.SHIFT_DOWN_MASK)
        assertEquals("first", panel.inputArea.text)
    }

    fun `test multi-line recall lets the caret move before walking`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("older"), user("l1\nl2"))
        key(panel, KeyEvent.VK_UP)
        assertEquals("l1\nl2", panel.inputArea.text)
        assertEquals(0, panel.inputArea.caretPosition)
        // Down on the first line of a multi-line prompt is not consumed (caret moves instead).
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("l1\nl2", panel.inputArea.text)
        // Caret on the second line: Up is not a recall.
        panel.inputArea.caretPosition = 4
        key(panel, KeyEvent.VK_UP)
        assertEquals("l1\nl2", panel.inputArea.text)
        // Caret back on the first line: Up recalls the older prompt.
        panel.inputArea.caretPosition = 1
        key(panel, KeyEvent.VK_UP)
        assertEquals("older", panel.inputArea.text)
        // Down from the last line of a single-line prompt walks newer, caret at the end.
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("l1\nl2", panel.inputArea.text)
        assertEquals(5, panel.inputArea.caretPosition)
        key(panel, KeyEvent.VK_DOWN)
        assertEquals("", panel.inputArea.text)
    }

    private fun settings(multi: Boolean) {
        val s = StewartSettings.getInstance().state
        s.multiModel = multi
        if (multi) {
            s.plannerModel = "fake/m1"
            s.executorModel = "fake/m1"
            s.workerModel = "fake/m1"
        }
    }

    fun `test busy indicator hidden when idle`() {
        val panel = newPanel(fakeProvider())
        assertFalse(panel.busyIcon.isVisible)
        assertEquals(" ", panel.activityLabel.text)
    }

    fun `test busy indicator shows role while running`() {
        val panel = newPanel(fakeProvider())
        panel.simulateLevelStartedForTest(com.adb.stewart.agents.AgentRole.WORKER, "task t1")
        assertTrue(panel.busyIcon.isVisible)
        assertEquals("Worker · task t1", panel.activityLabel.text)
        assertEquals("Stop", panel.sendButton.text)
    }

    fun `test busy indicator shows tool name then reverts and ignores blank tool`() {
        val panel = newPanel(fakeProvider())
        panel.simulateLevelStartedForTest(com.adb.stewart.agents.AgentRole.WORKER, "task t1")
        val l = panel.chatListener()
        val blank = com.adb.stewart.provider.ToolCall("c0", "", kotlinx.serialization.json.JsonObject(emptyMap()))
        l.onToolRequested(blank)
        assertEquals("Worker · task t1", panel.activityLabel.text)
        val call = com.adb.stewart.provider.ToolCall("c1", "ReadFile", kotlinx.serialization.json.JsonObject(emptyMap()))
        l.onToolRequested(call)
        assertEquals("Worker · ReadFile", panel.activityLabel.text)
        l.onToolOutcome(call, com.adb.stewart.tools.ToolOutcome.Success("ok"))
        assertEquals("Worker · task t1", panel.activityLabel.text)
    }

    fun `test busy cleared on completion failure and cancel`() {
        val role = com.adb.stewart.agents.AgentRole.WORKER
        val ends = listOf<(com.adb.stewart.chat.ChatListener) -> Unit>(
            { it.onCompleted(null) },
            { it.onFailed("boom") },
            { it.onCancelled() },
        )
        for (end in ends) {
            val panel = newPanel(fakeProvider())
            panel.simulateLevelStartedForTest(role, "task t1")
            assertTrue(panel.busyIcon.isVisible)
            end(panel.chatListener())
            assertFalse(panel.busyIcon.isVisible)
            assertEquals(" ", panel.activityLabel.text)
            assertEquals("Send", panel.sendButton.text)
        }
    }

    fun `test dispose disposes busy icon`() {
        val panel = newPanel(fakeProvider())
        assertFalse(com.intellij.openapi.util.Disposer.isDisposed(panel.busyIcon))
        panel.dispose()
        assertTrue(com.intellij.openapi.util.Disposer.isDisposed(panel.busyIcon))
    }

    // --- final review fixes ---

    private fun bubbleWidth(text: String): Int {
        val panel = newPanel(fakeProvider())
        val area = panel.addMessage("user", text)
        val row = area.parent as JPanel
        row.setSize(600, 2000)
        row.doLayout()
        return area.width
    }

    fun `test short user bubble hugs its text`() {
        assertTrue(bubbleWidth("hi") < 100)
    }

    fun `test longer user bubble is wider than a short one`() {
        assertTrue(bubbleWidth("x".repeat(60) + " " + "y".repeat(50)) > 300)
    }

    fun `test very long user bubble never exceeds row width minus inset`() {
        assertTrue(bubbleWidth("word ".repeat(400)) <= 600 - 60)
    }

    private fun toolCall(id: String) = com.adb.stewart.provider.ToolCall(
        id, "read_file", kotlinx.serialization.json.buildJsonObject { put("path", kotlinx.serialization.json.JsonPrimitive("a.txt")) },
    )

    fun `test restored tool message renders as a collapsed titled tool row`() {
        session.seedTranscriptForTest(
            user("go"),
            com.adb.stewart.provider.ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(toolCall("c1"))),
            com.adb.stewart.provider.ChatMessage(Role.TOOL, "y".repeat(5000), toolCallId = "c1"),
        )
        val panel = newPanel(fakeProvider())
        val row = panel.toolRows().single()
        assertTrue(row.headerText.contains("read_file"))
        assertFalse(row.bodyVisible)
        assertEquals(2000, row.body.text.length)
        assertEquals(listOf("go"), panel.messageAreas().filter { it !== row.body }.map { it.text })
    }

    fun `test restored assistant message with content and tool calls still renders`() {
        session.seedTranscriptForTest(
            com.adb.stewart.provider.ChatMessage(Role.ASSISTANT, "looking", toolCalls = listOf(toolCall("c1"))),
        )
        val panel = newPanel(fakeProvider())
        assertEquals(listOf("assistant: looking"), panel.messageAreas().map { it.text })
    }

    fun `test restored tool message with unknown call id gets a generic title`() {
        session.seedTranscriptForTest(com.adb.stewart.provider.ChatMessage(Role.TOOL, "out", toolCallId = "nope"))
        val panel = newPanel(fakeProvider())
        assertTrue(panel.toolRows().single().headerText.contains("tool"))
    }

    fun `test recalled slash prompt is re-escaped and does not open completions or clear`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("/clear the cache"))
        key(panel, KeyEvent.VK_UP)
        assertEquals("//clear the cache", panel.inputArea.text)
        assertTrue(names(panel).isEmpty())
        key(panel, KeyEvent.VK_ENTER)
        pump()
        assertFalse(panel.statusLabel.text == "History cleared")
        assertTrue(session.transcript.any { it.content == "/clear the cache" })
    }

    fun `test recalled ordinary prompt is unchanged`() {
        val panel = newPanel(fakeProvider())
        session.seedTranscriptForTest(user("clear the cache"))
        key(panel, KeyEvent.VK_UP)
        assertEquals("clear the cache", panel.inputArea.text)
    }

    // ---- image attachments ----

    private fun visionProvider(vision: Boolean, requests: MutableList<ChatRequest> = mutableListOf()) = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> = listOf(ModelInfo(ModelRef(id, "m1"), "m1"))
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            requests += request
            emit(ProviderEvent.TextDelta("hi"))
            emit(ProviderEvent.Completed("stop", Usage(1, 1)))
        }
        override fun supportsImages(model: String) = vision
    }

    private fun img(name: String = "a.png") = com.adb.stewart.chat.ImageAttachment(
        "image/png",
        java.io.ByteArrayOutputStream().also {
            javax.imageio.ImageIO.write(java.awt.image.BufferedImage(8, 8, java.awt.image.BufferedImage.TYPE_INT_RGB), "png", it)
        }.toByteArray(),
        name,
    )

    private class Fake(val flavor: java.awt.datatransfer.DataFlavor, val data: Any) : java.awt.datatransfer.Transferable {
        override fun getTransferDataFlavors() = arrayOf(flavor)
        override fun isDataFlavorSupported(f: java.awt.datatransfer.DataFlavor) = f == flavor
        override fun getTransferData(f: java.awt.datatransfer.DataFlavor): Any = data
    }

    fun `test paste image attaches and shows the strip`() {
        val panel = newPanel(visionProvider(true))
        val t = Fake(java.awt.datatransfer.DataFlavor.imageFlavor, java.awt.image.BufferedImage(8, 8, 1))
        assertTrue(panel.inputArea.transferHandler.importData(panel.inputArea, t))
        assertEquals(1, panel.pendingImages.size)
        assertTrue(panel.attachmentStrip.isVisible)
    }

    fun `test paste plain text inserts text and attaches nothing`() {
        val panel = newPanel(visionProvider(true))
        val t = java.awt.datatransfer.StringSelection("pasted")
        assertTrue(panel.inputArea.transferHandler.importData(panel.inputArea, t))
        assertEquals("pasted", panel.inputArea.text)
        assertTrue(panel.pendingImages.isEmpty())
        assertFalse(panel.attachmentStrip.isVisible)
    }

    fun `test drop on the panel attaches png only and reports txt`() {
        val panel = newPanel(visionProvider(true))
        val dir = java.nio.file.Files.createTempDirectory("drop").toFile()
        val png = java.io.File(dir, "a.png").also { it.writeBytes(img().bytes) }
        val txt = java.io.File(dir, "b.txt").also { it.writeText("x") }
        val t = Fake(java.awt.datatransfer.DataFlavor.javaFileListFlavor, listOf(png, txt))
        assertTrue(panel.transferHandler.importData(panel, t))
        assertEquals(listOf("a.png"), panel.pendingImages.map { it.name })
        assertTrue(panel.statusLabel.text.contains("b.txt"))
    }

    fun `test sixth image is rejected`() {
        val panel = newPanel(visionProvider(true))
        repeat(5) { assertTrue(panel.attach(img("i$it.png"))) }
        assertFalse(panel.attach(img("six.png")))
        assertEquals(5, panel.pendingImages.size)
        assertTrue(panel.statusLabel.text.contains("5"))
    }

    fun `test attachFile reports a missing file`() {
        val panel = newPanel(visionProvider(true))
        assertFalse(panel.attachFile(java.nio.file.Path.of("/nonexistent/none.png")))
        assertTrue(panel.statusLabel.text.contains("not found"))
        assertTrue(panel.pendingImages.isEmpty())
    }

    fun `test attachFile attaches a valid image`() {
        val panel = newPanel(visionProvider(true))
        val f = java.nio.file.Files.createTempDirectory("af").resolve("ok.png")
        java.nio.file.Files.write(f, img().bytes)
        assertTrue(panel.attachFile(f))
        assertEquals(listOf("ok.png"), panel.pendingImages.map { it.name })
    }

    fun `test image only submit sends and clears the strip`() {
        val requests = mutableListOf<ChatRequest>()
        val panel = newPanel(visionProvider(true, requests))
        panel.attach(img())
        panel.inputArea.text = ""
        panel.sendButton.doClick()
        assertTrue(pumpUntil { panel.sendButton.text == "Send" && requests.isNotEmpty() })
        assertEquals("", session.transcript[0].content)
        assertEquals(1, session.transcript[0].images.size)
        assertEquals(1, requests.first().messages.last { it.role == Role.USER }.images.size)
        assertTrue(panel.pendingImages.isEmpty())
        assertFalse(panel.attachmentStrip.isVisible)
    }

    fun `test user bubble shows a thumbnail`() {
        val panel = newPanel(visionProvider(true))
        panel.addMessage("user", "look", listOf(img()))
        val area = panel.messageAreas().first()
        val row = area.parent as JPanel
        val thumbs = (row.layout as BorderLayout).getLayoutComponent(BorderLayout.NORTH) as JPanel
        val label = thumbs.components.filterIsInstance<javax.swing.JLabel>().single()
        assertTrue(pumpUntil { com.adb.stewart.ui.ImageThumbnails.pending() == 0 })
        assertNotNull(label.icon)
        assertTrue(label.icon.iconWidth <= 160 && label.icon.iconHeight <= 160)
    }

    fun `test restored history renders thumbnails for user messages with images`() {
        session.seedTranscriptForTest(com.adb.stewart.provider.ChatMessage(Role.USER, "see", images = listOf(img())))
        val panel = newPanel(visionProvider(true))
        val row = panel.messageAreas().first().parent as JPanel
        assertNotNull((row.layout as BorderLayout).getLayoutComponent(BorderLayout.NORTH))
        assertTrue(pumpUntil { com.adb.stewart.ui.ImageThumbnails.pending() == 0 })
    }

    fun `test non vision model blocks send and keeps attachments`() {
        val requests = mutableListOf<ChatRequest>()
        val panel = newPanel(visionProvider(false, requests))
        panel.attach(img())
        panel.inputArea.text = "what is this"
        panel.sendButton.doClick()
        pump()
        assertTrue(panel.statusLabel.text.contains("does not accept images"))
        assertEquals(1, panel.pendingImages.size)
        assertEquals("what is this", panel.inputArea.text)
        assertTrue(requests.isEmpty())
        assertTrue(session.transcript.isEmpty())
        assertEquals("Send", panel.sendButton.text)
    }

    fun `test text only send to a non vision model still works`() {
        val requests = mutableListOf<ChatRequest>()
        val panel = newPanel(visionProvider(false, requests))
        panel.inputArea.text = "hello"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { requests.isNotEmpty() })
    }

    fun `test clear removes attachments`() {
        val panel = newPanel(visionProvider(true))
        panel.attach(img())
        panel.clearButton.doClick()
        assertTrue(panel.pendingImages.isEmpty())
        assertFalse(panel.attachmentStrip.isVisible)
    }

    fun `test strip remove button removes that attachment`() {
        val panel = newPanel(visionProvider(true))
        panel.attach(img("a.png"))
        panel.attach(img("b.png"))
        assertEquals(listOf("a.png", "b.png"), panel.attachmentStrip.names)
        panel.attachmentStrip.removeButtons[0].doClick()
        assertEquals(listOf("b.png"), panel.pendingImages.map { it.name })
        panel.attachmentStrip.removeButtons[0].doClick()
        assertFalse(panel.attachmentStrip.isVisible)
    }

    fun `test image slash command attaches relative to the project`() {
        val panel = newPanel(visionProvider(true))
        val base = java.nio.file.Path.of(project.basePath!!)
        java.nio.file.Files.createDirectories(base)
        val f = base.resolve("slash.png")
        java.nio.file.Files.write(f, img().bytes)
        try {
            panel.inputArea.text = "/image slash.png"
            panel.sendButton.doClick()
            assertEquals(listOf("slash.png"), panel.pendingImages.map { it.name })
            assertEquals("", panel.inputArea.text)
        } finally {
            java.nio.file.Files.deleteIfExists(f)
        }
    }

    fun `test image slash command with a missing file keeps the input`() {
        val panel = newPanel(visionProvider(true))
        panel.inputArea.text = "/image nope.png"
        panel.sendButton.doClick()
        assertTrue(panel.pendingImages.isEmpty())
        assertEquals("/image nope.png", panel.inputArea.text)
        assertTrue(panel.messageAreas().last().text.contains("not found"))
    }

    fun `test image slash command without an argument shows usage`() {
        val panel = newPanel(visionProvider(true))
        panel.inputArea.text = "/image"
        panel.sendButton.doClick()
        assertTrue(panel.messageAreas().last().text.contains("Usage: /image"))
    }

    fun `test attach button exists`() {
        val panel = newPanel(visionProvider(true))
        assertEquals("Attach image", panel.attachButton.toolTipText)
    }

    private fun multiProvider(requests: MutableList<ChatRequest>) = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> =
            listOf(ModelInfo(ModelRef(id, "m1"), "m1"), ModelInfo(ModelRef(id, "v"), "v"))
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            requests += request
            emit(ProviderEvent.TextDelta("hi"))
            emit(ProviderEvent.Completed("stop", Usage(1, 1)))
        }
        override fun supportsImages(model: String) = model == "v"
    }

    private fun multiPanel(plannerModel: String, requests: MutableList<ChatRequest>): ChatPanel {
        val st = StewartSettings.getInstance()
        st.state.multiModel = true
        com.adb.stewart.agents.AgentRole.entries.forEach { st.setRoleModel(it, ModelRef("fake", "m1")) }
        st.setRoleModel(com.adb.stewart.agents.AgentRole.PLANNER, ModelRef("fake", plannerModel))
        val panel = newPanel(multiProvider(requests))
        selectModel(panel, "fake", "v") // the combo is ignored in multi-model mode
        return panel
    }

    fun `test multi-model blocked send names the planner model and keeps state`() {
        val requests = mutableListOf<ChatRequest>()
        val panel = multiPanel("m1", requests)
        panel.attach(img())
        panel.inputArea.text = "look"
        panel.sendButton.doClick()
        pump()
        assertTrue(panel.statusLabel.text.contains("planner model fake/m1"))
        assertEquals(1, panel.pendingImages.size)
        assertEquals("look", panel.inputArea.text)
        assertTrue(requests.isEmpty())
        assertTrue(session.transcript.isEmpty())
    }

    fun `test multi-model send goes through when the planner supports images`() {
        val requests = mutableListOf<ChatRequest>()
        val panel = multiPanel("v", requests)
        selectModel(panel, "fake", "m1") // combo model is non-vision but irrelevant
        panel.attach(img())
        panel.inputArea.text = "look"
        panel.sendButton.doClick()
        assertTrue(pumpUntil { requests.isNotEmpty() })
        assertTrue(panel.pendingImages.isEmpty())
    }

    fun `test thumbnails are decoded once and swapped in after the placeholder`() {
        val a = img("cache-${System.nanoTime()}.png")
        val before = com.adb.stewart.ui.ImageThumbnails.decodeCount.get()
        val first = com.adb.stewart.ui.ImageThumbnails.label(a, 48)
        JPanel().add(first)
        assertEquals("…", first.text)
        assertNull(first.icon)
        assertTrue(pumpUntil { com.adb.stewart.ui.ImageThumbnails.pending() == 0 })
        assertNotNull(first.icon)
        val second = com.adb.stewart.ui.ImageThumbnails.label(a, 48)
        assertNotNull(second.icon) // cache hit, immediate
        assertEquals(before + 1, com.adb.stewart.ui.ImageThumbnails.decodeCount.get())
    }

    fun `test corrupt image keeps its name as text and does not throw`() {
        val bad = com.adb.stewart.chat.ImageAttachment("image/png", byteArrayOf(1, 2, 3), "bad-${System.nanoTime()}.png")
        val l = com.adb.stewart.ui.ImageThumbnails.label(bad, 48)
        JPanel().add(l)
        assertTrue(pumpUntil { com.adb.stewart.ui.ImageThumbnails.pending() == 0 })
        assertNull(l.icon)
        assertEquals(bad.name, l.text)
    }

    fun `test thumbnail removed before decode finishes is left alone`() {
        val a = img("gone-${System.nanoTime()}.png")
        val l = com.adb.stewart.ui.ImageThumbnails.label(a, 48) // never parented
        assertTrue(pumpUntil { com.adb.stewart.ui.ImageThumbnails.pending() == 0 })
        assertEquals("…", l.text)
    }
}

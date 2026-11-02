package com.aijb.assistant

import com.aijb.assistant.provider.aif.AifCredentials
import com.aijb.assistant.provider.claude.ClaudeLoginState
import com.aijb.assistant.settings.AijbConfigurable
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.settings.AijbSettingsListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.util.JDOMUtil
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.xmlb.XmlSerializer

class AijbConfigurableTest : BasePlatformTestCase() {

    private lateinit var configurable: AijbConfigurable

    override fun setUp() {
        super.setUp()
        AijbSettings.getInstance().loadState(AijbSettings.State())
        AifCredentials.set(null)
        configurable = AijbConfigurable()
        configurable.createPanel()
        configurable.reset()
    }

    override fun tearDown() {
        try {
            AijbSettings.getInstance().loadState(AijbSettings.State())
            AifCredentials.set(null)
        } finally {
            super.tearDown()
        }
    }

    private fun assertInvalid(block: () -> Unit) {
        val before = JDOMUtil.writeElement(XmlSerializer.serialize(AijbSettings.getInstance().state))
        try {
            block()
            fail("expected ConfigurationException")
        } catch (e: ConfigurationException) {
            // expected
        }
        assertEquals(before, JDOMUtil.writeElement(XmlSerializer.serialize(AijbSettings.getInstance().state)))
    }

    fun `test reset populates fields`() {
        assertEquals("http://localhost:11434", configurable.ollamaUrlField.text)
        assertEquals("", configurable.aifBaseUrlField.text)
        assertEquals("", String(configurable.apiKeyField.password))
        assertEquals("Not set", configurable.apiKeyStatus.text)
        assertEquals("claude", configurable.claudeCliPathField.text)
        assertEquals("80k", configurable.autoCompactField.text)
        assertFalse(configurable.debugLogCheck.isSelected)
        assertEquals("./log/debug_logs/", configurable.debugLogFolderField.text)
        assertFalse(configurable.isModified)
    }

    fun `test edit and apply persists`() {
        configurable.ollamaUrlField.text = "http://remote:11434"
        configurable.aifBaseUrlField.text = "https://aif.example/v1"
        configurable.aifModelsArea.text = "m1\nm2\n"
        configurable.claudeCliPathField.text = "/opt/claude"
        configurable.claudeModelsArea.text = "opus"
        configurable.overridesArea.text = "aif/m1=native\nollama/x=shim"
        configurable.autoCompactField.text = "120000"
        assertTrue(configurable.isModified)
        configurable.apply()
        val s = AijbSettings.getInstance().state
        assertEquals("http://remote:11434", s.ollamaUrl)
        assertEquals("https://aif.example/v1", s.aifBaseUrl)
        assertEquals(listOf("m1", "m2"), s.aifModels)
        assertEquals("/opt/claude", s.claudeCliPath)
        assertEquals(listOf("opus"), s.claudeModels)
        assertEquals(mapOf("aif/m1" to "NATIVE", "ollama/x" to "SHIM"), s.toolPathOverrides)
        assertEquals(120000, s.autoCompactTokens)
        assertFalse(configurable.isModified)
    }

    fun `test api key stored in password safe only`() {
        configurable.apiKeyField.text = "super-secret-key"
        assertTrue(configurable.isModified)
        configurable.apply()
        assertEquals("super-secret-key", AifCredentials.get())
        assertEquals("", String(configurable.apiKeyField.password))
        assertEquals("Stored", configurable.apiKeyStatus.text)
        val xml = JDOMUtil.writeElement(XmlSerializer.serialize(AijbSettings.getInstance().state))
        assertFalse(xml.contains("super-secret-key"))
    }

    fun `test clear key button`() {
        AifCredentials.set("k")
        configurable.reset()
        assertEquals("Stored", configurable.apiKeyStatus.text)
        configurable.clearKeyButton.doClick()
        assertNull(AifCredentials.get())
        assertEquals("Not set", configurable.apiKeyStatus.text)
    }

    fun `test invalid ollama url rejected`() {
        configurable.ollamaUrlField.text = "ftp://x"
        assertInvalid { configurable.apply() }
    }

    fun `test invalid aif base url rejected`() {
        configurable.aifBaseUrlField.text = "notaurl"
        assertInvalid { configurable.apply() }
        configurable.aifBaseUrlField.text = "https://x/v1?query=1"
        assertInvalid { configurable.apply() }
    }

    fun `test malformed override line rejected`() {
        configurable.overridesArea.text = "aif/m1 bogus"
        assertInvalid { configurable.apply() }
        configurable.overridesArea.text = "noslash=native"
        assertInvalid { configurable.apply() }
        configurable.overridesArea.text = "aif/m=bogus"
        assertInvalid { configurable.apply() }
    }

    fun `test native override for ollama accepted`() {
        configurable.overridesArea.text = "ollama/m=native"
        configurable.apply()
        assertEquals("NATIVE", AijbSettings.getInstance().state.toolPathOverrides["ollama/m"])
    }

    fun `test native override for non capable provider rejected`() {
        configurable.overridesArea.text = "claude/m=native"
        assertInvalid { configurable.apply() }
    }

    fun `test invalid auto compact rejected`() {
        configurable.autoCompactField.text = "abc"
        assertInvalid { configurable.apply() }
        configurable.autoCompactField.text = "0"
        assertInvalid { configurable.apply() }
    }

    fun `test tools checkboxes reset and apply`() {
        assertTrue(configurable.toolsEnabledCheck.isSelected)
        assertFalse(configurable.autoApproveCheck.isSelected)
        configurable.autoApproveCheck.isSelected = true
        configurable.toolsEnabledCheck.isSelected = false
        assertTrue(configurable.isModified)
        configurable.apply()
        val s = AijbSettings.getInstance().state
        assertTrue(s.autoApproveEdits)
        assertFalse(s.toolsEnabled)
        configurable.reset()
        assertTrue(configurable.autoApproveCheck.isSelected)
        assertFalse(configurable.toolsEnabledCheck.isSelected)
    }

    fun `test apply publishes topic`() {
        var fired = false
        ApplicationManager.getApplication().messageBus.connect(project)
            .subscribe(AijbSettings.TOPIC, AijbSettingsListener { fired = true })
        configurable.ollamaUrlField.text = "http://h:11434"
        configurable.apply()
        assertTrue(fired)
    }

    fun `test history retention defaults and persists`() {
        assertEquals("30", configurable.historyRetentionField.text)
        configurable.historyRetentionField.text = "7"
        assertTrue(configurable.isModified)
        configurable.apply()
        assertEquals(7, AijbSettings.getInstance().state.historyRetentionDays)
        assertFalse(configurable.isModified)
        configurable.historyRetentionField.text = "0"
        configurable.apply()
        assertEquals(0, AijbSettings.getInstance().state.historyRetentionDays)
    }

    fun `test invalid history retention rejected`() {
        for (bad in listOf("abc", "-1", "4000", "", "1.5")) {
            configurable.historyRetentionField.text = bad
            assertInvalid { configurable.apply() }
        }
    }

    fun `test debug log settings reset and apply`() {
        try {
            assertFalse(configurable.debugLogCheck.isSelected)
            assertEquals("./log/debug_logs/", configurable.debugLogFolderField.text)
            assertFalse(configurable.isModified)
            configurable.debugLogCheck.isSelected = true
            configurable.debugLogFolderField.text = "  /tmp/aijb-debug  "
            assertTrue(configurable.isModified)
            configurable.apply()
            val s = AijbSettings.getInstance().state
            assertTrue(s.debugLogEnabled)
            assertEquals("/tmp/aijb-debug", s.debugLogFolder)
            assertTrue(com.aijb.assistant.debug.DebugLogSink.isEnabled)
            assertEquals("/tmp/aijb-debug", com.aijb.assistant.debug.DebugLogSink.logDirectory)
            assertFalse(configurable.isModified)
            configurable.reset()
            assertTrue(configurable.debugLogCheck.isSelected)
            assertEquals("/tmp/aijb-debug", configurable.debugLogFolderField.text)
            configurable.debugLogFolderField.text = "   "
            configurable.apply()
            assertEquals("./log/debug_logs/", AijbSettings.getInstance().state.debugLogFolder)
            assertEquals("./log/debug_logs/", com.aijb.assistant.debug.DebugLogSink.logDirectory)
        } finally {
            com.aijb.assistant.debug.DebugLogSink.configure(false, "./log/debug_logs/")
        }
    }

    fun `test debug log retention applies and validates`() {
        try {
            assertEquals("7", configurable.debugLogRetentionField.text)
            configurable.debugLogRetentionField.text = "30"
            assertTrue(configurable.isModified)
            configurable.apply()
            assertEquals(30, AijbSettings.getInstance().state.debugLogRetentionDays)
            assertEquals(30, com.aijb.assistant.debug.DebugLogSink.retentionDays)
            assertFalse(configurable.isModified)
            for (ok in listOf("0", "365")) {
                configurable.debugLogRetentionField.text = ok
                configurable.apply()
                assertEquals(ok.toInt(), AijbSettings.getInstance().state.debugLogRetentionDays)
            }
            for (bad in listOf("-1", "366", "abc", "")) {
                configurable.debugLogRetentionField.text = bad
                assertInvalid { configurable.apply() }
            }
            assertEquals(365, AijbSettings.getInstance().state.debugLogRetentionDays)
        } finally {
            com.aijb.assistant.debug.DebugLogSink.configure(false, "./log/debug_logs/")
        }
    }

    fun `test check login reports signed in account`() {
        configurable.claudeCliPathField.text = "/opt/claude"
        var checkedPath: String? = null
        configurable.loginStatusCheck = { path ->
            checkedPath = path
            ClaudeLoginState(true, "oauth", "max", null)
        }
        configurable.loginCheckExecutor = { it() }
        assertEquals("Not checked yet", configurable.claudeLoginStatus.text)
        configurable.checkLoginButton.doClick()
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals("/opt/claude", checkedPath)
        assertEquals("Logged in (max, oauth)", configurable.claudeLoginStatus.text)
    }

    fun `test check login reports signed out and failure`() {
        configurable.loginStatusCheck = { ClaudeLoginState(false, null, null, "auth status exit 1") }
        configurable.loginCheckExecutor = { it() }
        configurable.checkLoginButton.doClick()
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals("Not logged in: auth status exit 1", configurable.claudeLoginStatus.text)

        configurable.loginStatusCheck = { throw IllegalStateException("cannot start CLI") }
        configurable.checkLoginButton.doClick()
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals("Not logged in: cannot start CLI", configurable.claudeLoginStatus.text)
    }

    fun `test check login falls back to default cli path`() {
        var checkedPath: String? = null
        configurable.claudeCliPathField.text = "   "
        configurable.loginStatusCheck = { path ->
            checkedPath = path
            ClaudeLoginState(true, null, null, null)
        }
        configurable.loginCheckExecutor = { it() }
        configurable.checkLoginButton.doClick()
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals("claude", checkedPath)
        assertEquals("Logged in", configurable.claudeLoginStatus.text)
    }
}

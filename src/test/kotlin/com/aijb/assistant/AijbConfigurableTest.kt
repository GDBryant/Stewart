package com.aijb.assistant

import com.aijb.assistant.provider.aif.AifCredentials
import com.aijb.assistant.settings.AijbConfigurable
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.settings.AijbSettingsListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.util.JDOMUtil
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

    fun `test native override for non capable provider rejected`() {
        configurable.overridesArea.text = "ollama/m=native"
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
}

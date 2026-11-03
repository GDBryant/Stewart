package com.adb.stewart

import com.adb.stewart.provider.ModelRef
import com.adb.stewart.settings.StewartSettings
import com.adb.stewart.settings.TokenCount
import com.intellij.util.xmlb.XmlSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StewartSettingsTest {

    @Test
    fun `defaults`() {
        val s = StewartSettings.State()
        assertEquals("http://localhost:11434", s.ollamaUrl)
        assertEquals("", s.aifBaseUrl)
        assertEquals(emptyList<String>(), s.aifModels)
        assertEquals("claude", s.claudeCliPath)
        assertEquals(emptyList<String>(), s.claudeModels)
        assertEquals(emptyMap<String, String>(), s.toolPathOverrides)
        assertEquals(emptySet<String>(), s.visionModelOverrides)
        assertEquals(false, s.multiModel)
        assertNull(s.chatModel)
        assertNull(s.plannerModel)
        assertNull(s.executorModel)
        assertNull(s.workerModel)
        assertEquals(80000, s.autoCompactTokens)
        assertEquals(false, s.debugLogEnabled)
        assertEquals("./log/debug_logs/", s.debugLogFolder)
        assertEquals(7, s.debugLogRetentionDays)
        val settings = StewartSettings()
        assertEquals(listOf("sonnet", "opus", "haiku"), settings.effectiveClaudeModels)
        settings.state.claudeModels = mutableListOf("opus")
        assertEquals(listOf("opus"), settings.effectiveClaudeModels)
    }

    @Test
    fun `state round trip preserves every field`() {
        val s = StewartSettings.State()
        s.ollamaUrl = "http://host:1"
        s.aifBaseUrl = "https://aif.example/v1"
        s.aifModels = mutableListOf("a", "b")
        s.claudeCliPath = "/opt/claude"
        s.claudeModels = mutableListOf("opus")
        s.toolPathOverrides = mutableMapOf("aif/x" to "NATIVE", "ollama/y" to "SHIM")
        s.visionModelOverrides = mutableSetOf("aif/v1", "aif/v2")
        s.multiModel = true
        s.chatModel = "aif/a"
        s.plannerModel = "claude/opus"
        s.executorModel = "ollama/q"
        s.workerModel = "ollama/w"
        s.autoCompactTokens = 120000
        s.debugLogEnabled = true
        s.debugLogFolder = "/tmp/stewart/debug/"
        s.debugLogRetentionDays = 30
        val element = XmlSerializer.serialize(s)
        val restored = XmlSerializer.deserialize(element, StewartSettings.State::class.java)
        assertEquals(s.ollamaUrl, restored.ollamaUrl)
        assertEquals(s.aifBaseUrl, restored.aifBaseUrl)
        assertEquals(s.aifModels, restored.aifModels)
        assertEquals(s.claudeCliPath, restored.claudeCliPath)
        assertEquals(s.claudeModels, restored.claudeModels)
        assertEquals(s.toolPathOverrides, restored.toolPathOverrides)
        assertEquals(s.visionModelOverrides, restored.visionModelOverrides)
        assertEquals(s.multiModel, restored.multiModel)
        assertEquals(s.chatModel, restored.chatModel)
        assertEquals(s.plannerModel, restored.plannerModel)
        assertEquals(s.executorModel, restored.executorModel)
        assertEquals(s.workerModel, restored.workerModel)
        assertEquals(s.autoCompactTokens, restored.autoCompactTokens)
        assertEquals(s.debugLogEnabled, restored.debugLogEnabled)
        assertEquals(s.debugLogFolder, restored.debugLogFolder)
        assertEquals(30, restored.debugLogRetentionDays)
        val viaLoad = StewartSettings().also { it.loadState(restored) }
        assertEquals("aif/a", viaLoad.state.chatModel)
        assertEquals(true, viaLoad.state.debugLogEnabled)
        assertEquals("/tmp/stewart/debug/", viaLoad.state.debugLogFolder)
    }

    @Test
    fun `loadState migrates claude display names`() {
        val s = StewartSettings.State()
        s.claudeModels = mutableListOf("Opus 5.5", "Sonnet 5.5", "sonnet", "Haiku 5.5")
        s.chatModel = "claude/Sonnet 5.5"
        s.plannerModel = "claude/Claude Opus 5.5"
        s.executorModel = "aif/My Model 1"
        s.workerModel = null
        val settings = StewartSettings()
        settings.loadState(s)
        assertEquals(listOf("opus", "sonnet", "haiku"), settings.state.claudeModels)
        assertEquals("claude/sonnet", settings.state.chatModel)
        assertEquals("claude/opus", settings.state.plannerModel)
        assertEquals("aif/My Model 1", settings.state.executorModel)
        assertNull(settings.state.workerModel)
    }

    @Test
    fun `loadState leaves valid state alone`() {
        val s = StewartSettings.State()
        s.claudeModels = mutableListOf("sonnet")
        s.chatModel = "claude/sonnet"
        val settings = StewartSettings()
        settings.loadState(s)
        assertEquals(listOf("sonnet"), settings.state.claudeModels)
        assertEquals("claude/sonnet", settings.state.chatModel)
    }

    @Test
    fun `model ref encode decode`() {
        assertEquals("ollama/m", ModelRef("ollama", "m").encode())
        assertEquals(ModelRef("ollama", "hf.co/u/m:q4"), ModelRef.decode("ollama/hf.co/u/m:q4"))
        assertEquals(ModelRef("aif", "x"), ModelRef.decode("aif/x"))
        assertNull(ModelRef.decode(null))
        assertNull(ModelRef.decode(""))
        assertNull(ModelRef.decode("   "))
        assertNull(ModelRef.decode("noslash"))
        assertNull(ModelRef.decode("/x"))
        assertNull(ModelRef.decode("x/"))
    }

    @Test
    fun `token count parse`() {
        assertEquals(80000, TokenCount.parse("80000"))
        assertEquals(80000, TokenCount.parse("80k"))
        assertEquals(80000, TokenCount.parse("80K"))
        assertEquals(80000, TokenCount.parse(" 80k "))
        assertEquals(1500, TokenCount.parse("1.5k"))
        assertNull(TokenCount.parse("0"))
        assertNull(TokenCount.parse("-5"))
        assertNull(TokenCount.parse("80kb"))
        assertNull(TokenCount.parse("k"))
        assertNull(TokenCount.parse(""))
        assertNull(TokenCount.parse("1.2345k"))
        assertNull(TokenCount.parse("99999999999"))
    }

    @Test
    fun `token count format round trips`() {
        assertEquals("80k", TokenCount.format(80000))
        assertEquals("12345", TokenCount.format(12345))
        listOf(80000, 120000, 1, 999, 12345).forEach {
            assertEquals(it, TokenCount.parse(TokenCount.format(it)))
        }
    }
}

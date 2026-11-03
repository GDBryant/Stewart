package com.adb.stewart

import com.adb.stewart.provider.ProviderRegistry
import com.adb.stewart.settings.StewartSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderRegistryTest {

    private fun registry(configure: StewartSettings.State.() -> Unit = {}): ProviderRegistry {
        val state = StewartSettings.State().apply(configure)
        return ProviderRegistry { state }
    }

    @Test
    fun `ollama and claude always present aif absent when blank`() {
        val r = registry()
        assertEquals(listOf("ollama", "claude"), r.providers().map { it.id })
        assertNull(r.provider("aif"))
    }

    @Test
    fun `aif present when base url set`() {
        val r = registry { aifBaseUrl = "https://aif.example/v1"; aifModels = mutableListOf("m") }
        assertEquals(listOf("ollama", "claude", "aif"), r.providers().map { it.id })
        assertEquals("aif", r.provider("aif")?.id)
    }

    @Test
    fun `same instances when config unchanged`() {
        val r = registry { aifBaseUrl = "https://aif.example/v1" }
        val first = r.providers()
        val second = r.providers()
        assertSame(first[0], second[0])
        assertSame(first[2], second[2])
    }

    @Test
    fun `instances rebuilt after config change`() {
        val state = StewartSettings.State()
        val r = ProviderRegistry { state }
        val first = r.provider("ollama")
        state.ollamaUrl = "http://other:11434"
        val second = r.provider("ollama")
        assertNotSame(first, second)
    }

    @Test
    fun `aif added when base url later set`() {
        val state = StewartSettings.State()
        val r = ProviderRegistry { state }
        assertNull(r.provider("aif"))
        state.aifBaseUrl = "https://aif.example/v1"
        assertEquals("aif", r.provider("aif")?.id)
    }

    @Test
    fun `aif is native unless overridden to shim`() {
        val state = StewartSettings.State().apply {
            aifBaseUrl = "https://aif.example/v1"
            toolPathOverrides = mutableMapOf("aif/m1" to "shim", "aif/m3" to "NATIVE")
        }
        val r = ProviderRegistry { state }
        val aif = r.provider("aif")!!
        assertFalse(aif.supportsNativeTools("m1"))
        assertTrue(aif.supportsNativeTools("m2"))
        assertTrue(aif.supportsNativeTools("m3"))
    }

    @Test
    fun `aif vision override comes from settings`() {
        val state = StewartSettings.State().apply {
            aifBaseUrl = "https://aif.example/v1"
            visionModelOverrides = mutableSetOf("aif/custom")
        }
        val aif = ProviderRegistry { state }.provider("aif")!!
        assertTrue(aif.supportsImages("custom"))
        assertFalse(aif.supportsImages("other"))
        assertFalse(aif.supportsImages("ollama/custom"))
    }

    @Test
    fun `claude provider uses configured path and models`() {
        val r = registry {
            claudeCliPath = "/opt/claude"
            claudeModels = mutableListOf("opus")
        }
        val claude = r.provider("claude")!!
        kotlinx.coroutines.runBlocking {
            assertEquals(listOf("opus"), claude.listModels().map { it.ref.modelId })
        }
    }

    @Test
    fun `provider lookup unknown returns null`() {
        assertNull(registry().provider("nope"))
    }
}

package com.aijb.assistant

import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.ToolPath
import com.aijb.assistant.settings.ToolPathResolver
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.junit.Assert.assertEquals
import org.junit.Test

class ToolPathResolverTest {

    private fun provider(id: String, native: Boolean) = object : ModelProvider {
        override val id = id
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow { }
        override fun supportsNativeTools(model: String) = native
    }

    @Test
    fun `native capable set`() {
        assertEquals(setOf("aif", "ollama"), ToolPathResolver.NATIVE_CAPABLE)
    }

    @Test
    fun `override native wins`() {
        val p = provider("aif", native = false)
        assertEquals(ToolPath.NATIVE,
            ToolPathResolver.resolve(ModelRef("aif", "m"), p, mapOf("aif/m" to "NATIVE")))
    }

    @Test
    fun `override shim wins over native support`() {
        val p = provider("aif", native = true)
        assertEquals(ToolPath.SHIM,
            ToolPathResolver.resolve(ModelRef("aif", "m"), p, mapOf("aif/m" to "SHIM")))
    }

    @Test
    fun `override value case insensitive`() {
        val p = provider("aif", native = false)
        assertEquals(ToolPath.NATIVE,
            ToolPathResolver.resolve(ModelRef("aif", "m"), p, mapOf("aif/m" to "native")))
        assertEquals(ToolPath.SHIM,
            ToolPathResolver.resolve(ModelRef("aif", "m"), p, mapOf("aif/m" to "shim")))
    }

    @Test
    fun `default native when supported`() {
        val p = provider("aif", native = true)
        assertEquals(ToolPath.NATIVE,
            ToolPathResolver.resolve(ModelRef("aif", "m"), p, emptyMap()))
    }

    @Test
    fun `default shim otherwise`() {
        val p = provider("ollama", native = false)
        assertEquals(ToolPath.SHIM,
            ToolPathResolver.resolve(ModelRef("ollama", "m"), p, emptyMap()))
    }

    @Test
    fun `override keyed per model`() {
        val p = provider("aif", native = false)
        assertEquals(ToolPath.SHIM,
            ToolPathResolver.resolve(ModelRef("aif", "other"), p, mapOf("aif/m" to "NATIVE")))
    }
}

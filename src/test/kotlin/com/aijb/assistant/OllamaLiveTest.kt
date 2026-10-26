package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ollama.OllamaProvider
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class OllamaLiveTest {

    @Test
    fun `live ollama lists models and streams`() = runBlocking {
        assumeTrue("OLLAMA_LIVE not set", System.getenv("OLLAMA_LIVE") == "1")
        val provider = OllamaProvider()
        val models = provider.listModels()
        assertTrue(models.any { it.ref.modelId == "north-mini-code-1.0:latest" })
        val events = mutableListOf<ProviderEvent>()
        withTimeout(120_000) {
            provider.chat(
                ChatRequest(
                    "north-mini-code-1.0:latest",
                    listOf(ChatMessage(Role.USER, "Reply with the word ok.")),
                )
            ).collect { events.add(it) }
        }
        assertTrue(events.count { it is ProviderEvent.TextDelta } >= 1)
        assertTrue(events.last() is ProviderEvent.Completed)
    }
}

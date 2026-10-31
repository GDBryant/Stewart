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

    @Test
    fun `live ollama native tool round trip`() = runBlocking {
        assumeTrue("OLLAMA_LIVE not set", System.getenv("OLLAMA_LIVE") == "1")
        val model = System.getenv("OLLAMA_TOOL_MODEL")
        assumeTrue("OLLAMA_TOOL_MODEL not set", !model.isNullOrBlank())
        val provider = OllamaProvider()
        provider.listModels()
        assertTrue("model lacks tools capability", provider.supportsNativeTools(model!!))
        var ran = false
        val tool = object : com.aijb.assistant.tools.Tool {
            override val spec = com.aijb.assistant.provider.ToolSpec(
                "get_magic_number", "Return the magic number",
                kotlinx.serialization.json.JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(
                arguments: kotlinx.serialization.json.JsonObject,
                preview: com.aijb.assistant.tools.ToolPreview?,
            ): String {
                ran = true
                return "42"
            }
        }
        val wrapped = com.aijb.assistant.shim.ToolCallingProvider(
            provider, com.aijb.assistant.provider.ToolPath.NATIVE)
        val loop = com.aijb.assistant.tools.ToolLoop(
            wrapped, com.aijb.assistant.tools.ToolRegistry(listOf(tool)),
            com.aijb.assistant.tools.ApprovalGate { _, _ ->
                com.aijb.assistant.tools.ApprovalDecision.Approved })
        val result = withTimeout(300_000) {
            loop.run(model, listOf(ChatMessage(
                Role.USER, "Call get_magic_number, then tell me the number.")),
                object : com.aijb.assistant.tools.LoopListener {})
        }
        assertTrue(ran)
        assertTrue(result is com.aijb.assistant.tools.LoopResult.Completed)
        val completed = result as com.aijb.assistant.tools.LoopResult.Completed
        assertTrue(completed.messages.last().content.contains("42"))
    }
}

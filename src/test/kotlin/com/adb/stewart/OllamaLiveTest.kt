package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ollama.OllamaProvider
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
        val tool = object : com.adb.stewart.tools.Tool {
            override val spec = com.adb.stewart.provider.ToolSpec(
                "get_magic_number", "Return the magic number",
                kotlinx.serialization.json.JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(
                arguments: kotlinx.serialization.json.JsonObject,
                preview: com.adb.stewart.tools.ToolPreview?,
            ): String {
                ran = true
                return "42"
            }
        }
        val wrapped = com.adb.stewart.shim.ToolCallingProvider(
            provider, com.adb.stewart.provider.ToolPath.NATIVE)
        val loop = com.adb.stewart.tools.ToolLoop(
            wrapped, com.adb.stewart.tools.ToolRegistry(listOf(tool)),
            com.adb.stewart.tools.ApprovalGate { _, _ ->
                com.adb.stewart.tools.ApprovalDecision.Approved })
        val result = withTimeout(300_000) {
            loop.run(model, listOf(ChatMessage(
                Role.USER, "Call get_magic_number, then tell me the number.")),
                object : com.adb.stewart.tools.LoopListener {})
        }
        assertTrue(ran)
        assertTrue(result is com.adb.stewart.tools.LoopResult.Completed)
        val completed = result as com.adb.stewart.tools.LoopResult.Completed
        assertTrue(completed.messages.last().content.contains("42"))
    }
}

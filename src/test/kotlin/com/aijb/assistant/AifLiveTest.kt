package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolPath
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.provider.aif.AifProvider
import com.aijb.assistant.shim.ToolCallingProvider
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolLoop
import com.aijb.assistant.tools.ToolRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class AifLiveTest {

    @Test
    fun `live aif drives a tool end to end`() = runBlocking {
        assumeTrue("AIF_LIVE not set", System.getenv("AIF_LIVE") == "1")
        val base = System.getenv("AIF_BASE_URL")!!
        val key = System.getenv("AIF_API_KEY")!!
        val model = System.getenv("AIF_MODEL")!!
        var ran = false
        val tool = object : Tool {
            override val spec = ToolSpec("get_magic_number", "Return the magic number", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject): String {
                ran = true
                return "42"
            }
        }
        val provider = ToolCallingProvider(AifProvider(base, listOf(model), { key }, java.net.http.HttpClient.newHttpClient()), ToolPath.SHIM)
        val loop = ToolLoop(provider, ToolRegistry(listOf(tool)), ApprovalGate { ApprovalDecision.Approved })
        val result = withTimeout(300_000) {
            loop.run(model, listOf(ChatMessage(Role.USER, "Call get_magic_number, then tell me the number.")), object : com.aijb.assistant.tools.LoopListener {})
        }
        assertTrue(ran)
        assertTrue(result is LoopResult.Completed)
        assertTrue((result as LoopResult.Completed).messages.last().content.contains("42"))
    }
}

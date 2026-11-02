package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.aif.AifProvider
import com.adb.stewart.shim.ToolCallingProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class AifLiveTest {

    @Test
    fun `live aif lists models`() = runBlocking {
        assumeTrue("AIF_LIVE not set", System.getenv("AIF_LIVE") == "1")
        val models = AifProvider(System.getenv("AIF_BASE_URL")!!, emptyList(), { System.getenv("AIF_API_KEY") }, java.net.http.HttpClient.newHttpClient()).listModels()
        assertTrue(models.isNotEmpty())
        assertTrue(models.any { it.ref.modelId == System.getenv("AIF_MODEL") })
    }

    @Test
    fun `live aif drives a tool end to end`() = drive(ToolPath.SHIM)

    @Test
    fun `live aif drives a tool end to end on the native path`() = drive(ToolPath.NATIVE)

    private fun drive(path: ToolPath) = runBlocking {
        assumeTrue("AIF_LIVE not set", System.getenv("AIF_LIVE") == "1")
        val base = System.getenv("AIF_BASE_URL")!!
        val key = System.getenv("AIF_API_KEY")!!
        val model = System.getenv("AIF_MODEL")!!
        var ran = false
        val tool = object : Tool {
            override val spec = ToolSpec("get_magic_number", "Return the magic number", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                ran = true
                return "42"
            }
        }
        val provider = ToolCallingProvider(AifProvider(base, listOf(model), { key }, java.net.http.HttpClient.newHttpClient(), { path == ToolPath.NATIVE }), path)
        val loop = ToolLoop(provider, ToolRegistry(listOf(tool)), ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val result = withTimeout(300_000) {
            loop.run(model, listOf(ChatMessage(Role.USER, "Call get_magic_number, then tell me the number.")), object : com.adb.stewart.tools.LoopListener {})
        }
        assertTrue(ran)
        assertTrue(result is LoopResult.Completed)
        assertTrue((result as LoopResult.Completed).messages.last().content.contains("42"))
    }
}

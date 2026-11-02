package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.claude.ClaudeProvider
import com.adb.stewart.shim.ToolCallingProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopListener
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolOutcome
import com.adb.stewart.tools.ToolRegistry
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class ClaudeLiveTest {

    private val model get() = System.getenv("CLAUDE_MODEL") ?: "haiku"

    private fun skip() = assumeTrue("CLAUDE_LIVE not set", System.getenv("CLAUDE_LIVE") == "1")

    @Test
    fun `live two tool turn loop`() = runBlocking {
        skip()
        val order = mutableListOf<String>()
        var lookupKey: String? = null
        val getKey = object : Tool {
            override val spec = ToolSpec("get_secret_key", "Return the secret key", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                order.add("get_secret_key")
                return "k-7"
            }
        }
        val lookup = object : Tool {
            override val spec = ToolSpec("lookup_value", "Look up a value by key", JsonObject(mapOf(
                "type" to JsonPrimitive("object"),
                "properties" to JsonObject(mapOf("key" to JsonObject(mapOf("type" to JsonPrimitive("string"))))),
                "required" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("key"))))))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                order.add("lookup_value")
                lookupKey = arguments["key"]?.let { (it as JsonPrimitive).content }
                return if (lookupKey == "k-7") "42" else "wrong key"
            }
        }
        val loop = ToolLoop(
            ToolCallingProvider(ClaudeProvider(), ToolPath.SHIM),
            ToolRegistry(listOf(getKey, lookup)),
            ApprovalGate { _, _ -> ApprovalDecision.Approved },
        )
        val result = withTimeout(300_000) {
            loop.run(model, listOf(ChatMessage(Role.USER,
                "Use get_secret_key to get the key, then lookup_value with that key, then tell me the value.")),
                object : LoopListener {})
        }
        assertEquals(listOf("get_secret_key", "lookup_value"), order)
        assertEquals("k-7", lookupKey)
        assertTrue(result is LoopResult.Completed)
        assertTrue((result as LoopResult.Completed).messages.last().content.contains("42"))
    }

    @Test
    fun `live isolation in disposable dir`() = runBlocking {
        skip()
        val dir = Files.createTempDirectory("aijb-live-iso-").toFile()
        val sentinel = java.io.File(dir, "sentinel.txt")
        sentinel.writeText("untouched")
        try {
            val loop = ToolLoop(
                ToolCallingProvider(ClaudeProvider(), ToolPath.SHIM),
                ToolRegistry(emptyList()),
                ApprovalGate { _, _ -> ApprovalDecision.Approved },
            )
            val result = withTimeout(300_000) {
                loop.run(model, listOf(ChatMessage(Role.USER,
                    "Create a file named pwned.txt and run `touch ran.txt` inside ${dir.absolutePath}.")),
                    object : LoopListener {})
            }
            assertTrue(result is LoopResult.Completed || result is LoopResult.Failed)
            if (result is LoopResult.Failed) {
                assertTrue(result.code != "isolation_violation")
            }
            assertTrue(!java.io.File(dir, "pwned.txt").exists())
            assertTrue(!java.io.File(dir, "ran.txt").exists())
            assertEquals("untouched", sentinel.readText())
        } finally {
            dir.deleteRecursively()
        }
    }
}

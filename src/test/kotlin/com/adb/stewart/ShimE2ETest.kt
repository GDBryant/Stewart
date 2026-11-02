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
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ShimE2ETest {

    private lateinit var server: HttpServer
    private val bodies = mutableListOf<String>()

    @Before fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/proxy/v1/chat/completions") { ex ->
            val body = ex.requestBody.bufferedReader().readText()
            bodies.add(body)
            val reply = if (bodies.size == 1) {
                "data: {\"choices\":[{\"delta\":{\"content\":\"<tool_call>\\n{\\\"name\\\": \\\"get_magic_number\\\", \\\"arguments\\\": {}}\\n</tool_call>\"},\"finish_reason\":null}]}\n" +
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n"
            } else {
                "data: {\"choices\":[{\"delta\":{\"content\":\"The number is 42.\"},\"finish_reason\":null}]}\n" +
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\ndata: [DONE]\n"
            }
            ex.sendResponseHeaders(200, reply.toByteArray().size.toLong())
            ex.responseBody.use { it.write(reply.toByteArray()) }
        }
        server.start()
    }

    @After fun tearDown() { server.stop(0) }

    @Test
    fun `end to end shim tool loop`() = runBlocking {
        var ran = 0
        val tool = object : Tool {
            override val spec = ToolSpec("get_magic_number", "d", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                ran++
                return "42"
            }
        }
        val aif = AifProvider("http://127.0.0.1:${server.address.port}/api/proxy/v1", listOf("m"), { "test-api-key" },
            java.net.http.HttpClient.newHttpClient())
        val loop = ToolLoop(ToolCallingProvider(aif, ToolPath.SHIM), ToolRegistry(listOf(tool)),
            ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val result = loop.run("m", listOf(ChatMessage(Role.USER, "go")), object : com.adb.stewart.tools.LoopListener {})
        assertEquals(1, ran)
        assertTrue(result is LoopResult.Completed)
        assertEquals(2, bodies.size)
        assertTrue(bodies[1].contains("<tool_response>"))
        assertTrue(bodies[1].contains("42"))
        assertTrue(bodies[0].contains("<tools>"))
        assertTrue(!bodies[0].contains("\"tools\""))
    }
}

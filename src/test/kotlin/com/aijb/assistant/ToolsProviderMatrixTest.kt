package com.aijb.assistant

import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.provider.aif.AifProvider
import com.aijb.assistant.provider.claude.ClaudeProvider
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.ProjectTools
import com.aijb.assistant.tools.ToolOutcome
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * M5 acceptance matrix: every provider path reads, edits with approval and runs a command with
 * approval. AIF is driven over HTTP on both the native and shim paths; Claude runs through the
 * enterprise CLI shim.
 */
class ToolsProviderMatrixTest : BasePlatformTestCase() {

    private lateinit var scope: CoroutineScope
    private lateinit var session: ChatSession
    private lateinit var baseDir: File
    private var server: HttpServer? = null

    override fun setUp() {
        super.setUp()
        scope = CoroutineScope(SupervisorJob())
        session = ChatSession(project, scope)
        session.tools = { ProjectTools.registry(project, true) }
        session.autoCompactTokens = { 10_000_000 }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        baseDir = com.aijb.assistant.tools.ProjectPaths.forProject(project).base.toFile()
        baseDir.mkdirs()
    }

    override fun tearDown() {
        try {
            scope.cancel()
            server?.stop(0)
            server = null
        } finally {
            super.tearDown()
        }
    }

    private class L : ChatListener {
        val done = CountDownLatch(1)
        val failed = CountDownLatch(1)
        var failure: String? = null
        val toolCalls = mutableListOf<String>()
        val outcomes = mutableListOf<ToolOutcome>()
        override fun onDelta(text: String) {}
        override fun onCompleted(usage: Usage?) { done.countDown() }
        override fun onFailed(message: String) { failure = message; failed.countDown() }
        override fun onCancelled() { done.countDown() }
        override fun onToolRequested(call: ToolCall) { toolCalls += call.name }
        override fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) { outcomes += outcome }
    }

    private fun send(text: String, ref: ModelRef): L {
        val l = L()
        session.send(text, ref, l)
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (l.done.await(20, TimeUnit.MILLISECONDS) || l.failed.count == 0L) break
        }
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        return l
    }

    private fun file(rel: String, content: String): File {
        val f = File(baseDir, rel)
        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(
            project, null, null, Runnable {
            val dir = com.intellij.openapi.vfs.VfsUtil.createDirectories(
                f.parent.replace(File.separatorChar, '/'))
            val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                .findFileByPath(f.absolutePath.replace(File.separatorChar, '/'))
                ?: dir.createChildData(this, f.name)
            com.intellij.openapi.vfs.VfsUtil.saveText(vf, content)
        })
        return f
    }

    private fun sse(vararg chunks: String): String =
        chunks.joinToString("") { "data: $it\n\n" } + "data: [DONE]\n\n"

    private fun nativeToolTurn(id: String, name: String, args: JsonObject): String {
        val call = buildJsonObject {
            put("index", JsonPrimitive(0))
            put("id", JsonPrimitive(id))
            put("type", JsonPrimitive("function"))
            put("function", buildJsonObject {
                put("name", JsonPrimitive(name))
                put("arguments", JsonPrimitive(args.toString()))
            })
        }
        return sse(
            """{"choices":[{"delta":{"tool_calls":[$call]}}]}""",
            """{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}""",
        )
    }

    private fun shimToolTurn(name: String, args: JsonObject): String {
        val text = "<tool_call>\n" +
            buildJsonObject {
                put("name", JsonPrimitive(name))
                put("arguments", args)
            }.toString() + "\n</tool_call>"
        return sse(
            buildJsonObject {
                put("choices", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject {
                    put("delta", buildJsonObject { put("content", JsonPrimitive(text)) })
                })))
            }.toString(),
            """{"choices":[{"delta":{},"finish_reason":"stop"}]}""",
        )
    }

    private fun textTurn(text: String): String = sse(
        buildJsonObject {
            put("choices", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject {
                put("delta", buildJsonObject { put("content", JsonPrimitive(text)) })
            })))
        }.toString(),
        """{"choices":[{"delta":{},"finish_reason":"stop"}]}""",
    )

    private fun aif(turns: List<String>, nativeTools: Boolean): AifProvider {
        val srv = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var served = 0
        srv.createContext("/v1/chat/completions") { ex ->
            ex.requestBody.readBytes()
            val body = turns.getOrElse(served++) { textTurn("done") }
            val bytes = body.toByteArray()
            ex.responseHeaders.add("Content-Type", "text/event-stream")
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        srv.start()
        server = srv
        return AifProvider("http://127.0.0.1:${srv.address.port}/v1", listOf("m"), { "k" },
            java.net.http.HttpClient.newHttpClient(), { nativeTools })
    }

    private fun runMatrix(native: Boolean) {
        file("f.txt", "alpha")
        val edit = file("e.txt", "aaa bbb")
        val readArgs = buildJsonObject { put("path", JsonPrimitive("f.txt")) }
        val editArgs = buildJsonObject {
            put("path", JsonPrimitive("e.txt"))
            put("old_string", JsonPrimitive("aaa"))
            put("new_string", JsonPrimitive("ccc"))
        }
        val cmdArgs = buildJsonObject { put("command", JsonPrimitive("touch ran.txt")) }
        val turns = if (native) {
            listOf(
                nativeToolTurn("c1", "ReadFile", readArgs),
                nativeToolTurn("c2", "EditFile", editArgs),
                nativeToolTurn("c3", "RunTerminal", cmdArgs),
                textTurn("done"),
            )
        } else {
            listOf(
                shimToolTurn("ReadFile", readArgs),
                shimToolTurn("EditFile", editArgs),
                shimToolTurn("RunTerminal", cmdArgs),
                textTurn("done"),
            )
        }
        session.providers = { listOf(aif(turns, native)) }
        session.toolPathOverrides = { mapOf("aif/m" to if (native) "NATIVE" else "SHIM") }
        val l = send("do it", ModelRef("aif", "m"))
        assertTrue("failed: ${l.failure}", l.done.count == 0L)
        assertEquals(listOf("ReadFile", "EditFile", "RunTerminal"), l.toolCalls)
        assertEquals("ccc bbb", edit.readText())
        assertTrue("command must have run", File(baseDir, "ran.txt").exists())
        assertTrue("read result must be fed back",
            session.transcript.any { it.role == Role.TOOL && it.content.contains("alpha") })
    }

    fun `test aif native path reads edits and runs commands`() = runMatrix(native = true)

    fun `test aif shim path reads edits and runs commands`() = runMatrix(native = false)

    fun `test aif native edit rejected leaves file untouched`() {
        val edit = file("e.txt", "aaa bbb")
        val editArgs = buildJsonObject {
            put("path", JsonPrimitive("e.txt"))
            put("old_string", JsonPrimitive("aaa"))
            put("new_string", JsonPrimitive("ccc"))
        }
        session.providers = { listOf(aif(listOf(nativeToolTurn("c1", "EditFile", editArgs), textTurn("done")), true)) }
        session.toolPathOverrides = { mapOf("aif/m" to "NATIVE") }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Rejected("no") }
        val l = send("edit", ModelRef("aif", "m"))
        assertTrue("failed: ${l.failure}", l.done.count == 0L)
        assertEquals("aaa bbb", edit.readText())
        assertTrue(l.outcomes.any { it is ToolOutcome.Rejected })
    }

    private fun claude(turns: List<String>): ClaudeProvider {
        val fixtureDir = createTempDir()
        val recordDir = createTempDir()
        turns.forEachIndexed { i, body -> File(fixtureDir, "${i + 1}.json").writeText(body) }
        File(fixtureDir, "last.json").writeText(turns.last())
        val fakeScript = File("src/test/resources/claude/fake-claude.sh").absoluteFile
        fakeScript.setExecutable(true)
        return ClaudeProvider(cliPath = fakeScript.absolutePath, extraEnv = mapOf(
            "FAKE_RECORD" to recordDir.absolutePath,
            "FAKE_FIXTURE_DIR" to fixtureDir.absolutePath))
    }

    private fun claudeTurn(text: String): String =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":" +
            JsonPrimitive(text).toString() + "}}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\"," +
            "\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n"

    private fun claudeShimCall(name: String, args: JsonObject): String =
        claudeTurn("<tool_call>\n" + buildJsonObject {
            put("name", JsonPrimitive(name))
            put("arguments", args)
        }.toString() + "\n</tool_call>")

    fun `test claude cli path reads edits and runs commands`() {
        file("f.txt", "claude-alpha")
        val edit = file("e.txt", "aaa bbb")
        val readArgs = buildJsonObject { put("path", JsonPrimitive("f.txt")) }
        val editArgs = buildJsonObject {
            put("path", JsonPrimitive("e.txt"))
            put("old_string", JsonPrimitive("aaa"))
            put("new_string", JsonPrimitive("ccc"))
        }
        val cmdArgs = buildJsonObject { put("command", JsonPrimitive("touch claude-ran.txt")) }
        session.providers = {
            listOf(claude(listOf(
                claudeShimCall("ReadFile", readArgs),
                claudeShimCall("EditFile", editArgs),
                claudeShimCall("RunTerminal", cmdArgs),
                claudeTurn("done"),
            )))
        }
        val l = send("do it", ModelRef("claude", "m"))
        assertTrue("failed: ${l.failure}", l.done.count == 0L)
        assertEquals(listOf("ReadFile", "EditFile", "RunTerminal"), l.toolCalls)
        assertEquals("ccc bbb", edit.readText())
        assertTrue("command must have run", File(baseDir, "claude-ran.txt").exists())
        assertTrue("read result must be fed back",
            session.transcript.any { it.role == Role.TOOL && it.content.contains("claude-alpha") })
    }

    fun `test claude cli command rejected does not run`() {
        val cmdArgs = buildJsonObject { put("command", JsonPrimitive("touch claude-no.txt")) }
        session.providers = { listOf(claude(listOf(claudeShimCall("RunTerminal", cmdArgs), claudeTurn("done")))) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Rejected("no") }
        val l = send("run", ModelRef("claude", "m"))
        assertTrue("failed: ${l.failure}", l.done.count == 0L)
        assertFalse(File(baseDir, "claude-no.txt").exists())
        assertTrue(l.outcomes.any { it is ToolOutcome.Rejected })
    }
}

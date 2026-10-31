package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolPath
import com.aijb.assistant.provider.ollama.OllamaProvider
import com.aijb.assistant.shim.ToolCallingProvider
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.ProjectPaths
import com.aijb.assistant.tools.ProjectTools
import com.aijb.assistant.tools.ToolLoop
import com.intellij.openapi.roots.ModuleRootModificationUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

class OllamaToolsE2ETest : BasePlatformTestCase() {

    private lateinit var server: HttpServer
    private lateinit var baseDir: File
    private lateinit var paths: ProjectPaths
    private var turns = 0

    override fun setUp() {
        super.setUp()
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.start()
        paths = ProjectPaths.forProject(project)
        baseDir = paths.base.toFile()
        baseDir.mkdirs()
        val baseVf = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(baseDir.absolutePath)
        if (baseVf != null) {
            ModuleRootModificationUtil.updateModel(
                com.intellij.openapi.module.ModuleManager.getInstance(project).modules.first()
            ) { it.addContentEntry(baseVf) }
        }
    }

    override fun tearDown() {
        try {
            server.stop(0)
        } finally {
            super.tearDown()
        }
    }

    private fun provider(): ModelProvider =
        OllamaProvider("http://127.0.0.1:${server.address.port}")

    private val chatBodies = mutableListOf<String>()

    private fun respond(vararg lines: String) {
        server.createContext("/api/chat") { ex ->
            chatBodies += ex.requestBody.readBytes().decodeToString()
            val idx = turns.coerceAtMost(lines.size - 1)
            val body = lines[idx] + "\n"
            turns++
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
    }

    private fun nativeCall(name: String, args: String) =
        """{"message":{"tool_calls":[{"function":{"name":"$name","arguments":$args}}]},"done":true,"done_reason":"tool_calls"}"""

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

    private fun drive(path: ToolPath, gate: ApprovalGate, turns: List<String>, capable: Boolean = true): LoopResult {
        val p = provider()
        server.createContext("/api/tags") { ex ->
            val caps = if (capable) """["completion","tools"]""" else """["completion"]"""
            val body = """{"models":[{"name":"m","capabilities":$caps}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        runBlocking { p.listModels() }
        respond(*turns.toTypedArray())
        val loop = ToolLoop(ToolCallingProvider(p, path), ProjectTools.registry(project, true), gate)
        return runBlocking {
            withTimeout(120_000) {
                loop.run("m", listOf(ChatMessage(Role.USER, "go")),
                    object : com.aijb.assistant.tools.LoopListener {
                        override fun onToolOutcome(call: com.aijb.assistant.provider.ToolCall, outcome: com.aijb.assistant.tools.ToolOutcome) {
                            println("OUTCOME ${call.name} -> $outcome")
                        }
                    })
            }
        }
    }

    fun `test native read edit command e2e`() {
        file("e.txt", "alpha")
        val approvedNames = mutableListOf<String>()
        val approved = drive(ToolPath.NATIVE,
            ApprovalGate { call, _ -> approvedNames.add(call.name); ApprovalDecision.Approved },
            listOf(
                nativeCall("ReadFile", """{"path":"e.txt"}"""),
                nativeCall("EditFile", """{"path":"e.txt","old_string":"alpha","new_string":"beta"}"""),
                nativeCall("RunTerminal", """{"command":"echo hi > out.txt"}"""),
                """{"message":{"content":"done"},"done":true,"done_reason":"stop"}""",
            ))
        assertTrue(approved is LoopResult.Completed)
        assertEquals("beta", File(baseDir, "e.txt").readText())
        assertTrue(File(baseDir, "out.txt").readText().contains("hi"))
        assertEquals(listOf("EditFile", "RunTerminal"), approvedNames)
        val followup = chatBodies.drop(1).joinToString("\n")
        assertTrue(followup.contains("\"role\":\"tool\""))
        assertTrue(followup.contains("\"tool_name\":\"ReadFile\""))
        assertTrue(followup.contains("\"tool_name\":\"EditFile\""))
        assertTrue(followup.contains("\"tool_name\":\"RunTerminal\""))
    }

    fun `test native rejection makes no change`() {
        file("e.txt", "alpha")
        val rejected = drive(ToolPath.NATIVE, ApprovalGate { _, _ -> ApprovalDecision.Rejected("no") },
            listOf(
                nativeCall("EditFile", """{"path":"e.txt","old_string":"alpha","new_string":"beta"}"""),
                nativeCall("RunTerminal", """{"command":"echo x > should_not_exist.txt"}"""),
                """{"message":{"content":"done"},"done":true,"done_reason":"stop"}""",
            ))
        assertTrue(rejected is LoopResult.Completed)
        assertEquals("alpha", File(baseDir, "e.txt").readText())
        assertFalse(File(baseDir, "should_not_exist.txt").exists())
    }

    fun `test native unsupported fails no replay`() {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"m","capabilities":["completion","tools"]}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val p = provider()
        runBlocking { p.listModels() }
        var hits = 0
        server.createContext("/api/chat") { ex ->
            hits++
            val body = """{"error":"m does not support tools"}"""
            ex.sendResponseHeaders(400, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val loop = ToolLoop(ToolCallingProvider(p, ToolPath.NATIVE),
            ProjectTools.registry(project, true), ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val r = runBlocking {
            loop.run("m", listOf(ChatMessage(Role.USER, "go")),
                object : com.aijb.assistant.tools.LoopListener {})
        }
        assertTrue(r is LoopResult.Failed)
        assertEquals(1, hits)
    }

    fun `test shim path parses and executes`() {
        file("s.txt", "x")
        val p = provider()
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"m","capabilities":["completion"]}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        runBlocking { p.listModels() }
        assertEquals(ToolPath.SHIM, com.aijb.assistant.settings.ToolPathResolver.resolve(
            com.aijb.assistant.provider.ModelRef("ollama", "m"), p, emptyMap()))
        respond(
            """{"message":{"content":"<tool_call>{\"name\":\"EditFile\",\"arguments\":{\"path\":\"s.txt\",\"old_string\":\"x\",\"new_string\":\"y\"}}</tool_call>"},"done":true,"done_reason":"stop"}""",
            """{"message":{"content":"edited"},"done":true,"done_reason":"stop"}""",
        )
        val loop = ToolLoop(ToolCallingProvider(p, ToolPath.SHIM),
            ProjectTools.registry(project, true),
            ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val shimmed = runBlocking {
            withTimeout(120_000) {
                loop.run("m", listOf(ChatMessage(Role.USER, "go")),
                    object : com.aijb.assistant.tools.LoopListener {})
            }
        }
        assertTrue(shimmed is LoopResult.Completed)
        assertEquals("y", File(baseDir, "s.txt").readText())
        assertTrue(chatBodies.size >= 2)
    }

    fun `test capability discovery seeds native support`() = runBlocking {
        server.createContext("/api/tags") { ex ->
            val body = """{"models":[{"name":"m","capabilities":["completion","tools"]}]}"""
            ex.sendResponseHeaders(200, body.toByteArray().size.toLong())
            ex.responseBody.use { it.write(body.toByteArray()) }
        }
        val p = provider()
        p.listModels()
        assertTrue(p.supportsNativeTools("m"))
        assertFalse(p.supportsNativeTools("other"))
    }
}

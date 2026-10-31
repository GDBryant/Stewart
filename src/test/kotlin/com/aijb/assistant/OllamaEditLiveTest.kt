package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolPath
import com.aijb.assistant.provider.ollama.OllamaProvider
import com.aijb.assistant.shim.ToolCallingProvider
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.ProjectTools
import com.aijb.assistant.tools.ToolLoop
import com.intellij.openapi.roots.ModuleRootModificationUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

class OllamaEditLiveTest : BasePlatformTestCase() {

    private lateinit var baseDir: File

    override fun setUp() {
        super.setUp()
        val paths = com.aijb.assistant.tools.ProjectPaths.forProject(project)
        baseDir = paths.base.toFile()
        baseDir.mkdirs()
        val baseVf = LocalFileSystem.getInstance().refreshAndFindFileByPath(baseDir.absolutePath)
        if (baseVf != null) {
            ModuleRootModificationUtil.updateModel(
                com.intellij.openapi.module.ModuleManager.getInstance(project).modules.first()
            ) { it.addContentEntry(baseVf) }
        }
    }

    fun `test live ollama writes and edits a file on the shim path`() = drive(ToolPath.SHIM)

    fun `test live ollama writes and edits a file on the native path`() = drive(ToolPath.NATIVE)

    private fun drive(path: ToolPath) = runBlocking {
        if (System.getenv("OLLAMA_LIVE") != "1") return@runBlocking
        val model = System.getenv("OLLAMA_TOOL_MODEL") ?: return@runBlocking
        val name = "live_edit_${path.name.lowercase()}_${java.util.UUID.randomUUID().toString().take(8)}.txt"
        val target = File(baseDir, name)
        val approvals = mutableListOf<String>()
        val raw = OllamaProvider()
        raw.listModels()
        if (path == ToolPath.NATIVE && !raw.supportsNativeTools(model)) {
            if (System.getenv("OLLAMA_TOOL_MODEL") != null) {
                org.junit.Assert.fail("model $model lacks tools capability")
            }
            return@runBlocking
        }
        val provider = ToolCallingProvider(raw, path)
        val loop = ToolLoop(
            provider, ProjectTools.registry(project, true),
            ApprovalGate { call, preview ->
                approvals.add(call.name + ":" + preview.toString().take(300))
                ApprovalDecision.Approved
            })
        val prompt = """
            In this project, do exactly these steps using the tools:
            1. WriteFile path "$name" with content "alpha beta gamma"
            2. EditFile path "$name" replacing "beta" with "BETA"
            3. Reply with the word DONE.
        """.trimIndent()
        val result = withTimeout(300_000) {
            loop.run(model, listOf(ChatMessage(Role.USER, prompt)),
                object : com.aijb.assistant.tools.LoopListener {})
        }
        println("OLLAMA edit live [$path] approvals=$approvals")
        if (result is LoopResult.Completed) {
            println("OLLAMA edit live [$path] last=" + result.messages.last().content.take(600))
        } else {
            println("OLLAMA edit live [$path] result=$result")
        }
        assertTrue(target.isFile)
        assertEquals("alpha BETA gamma", target.readText())
        assertTrue(approvals.any { it.startsWith("WriteFile") })
        assertTrue(approvals.any { it.startsWith("EditFile") })
        assertTrue(result is LoopResult.Completed)
    }
}

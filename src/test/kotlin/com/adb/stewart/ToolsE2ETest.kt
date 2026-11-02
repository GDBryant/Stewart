package com.adb.stewart

import com.adb.stewart.chat.ChatListener
import com.adb.stewart.chat.ChatSession
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.Usage
import com.adb.stewart.provider.claude.ClaudeProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.ProjectTools
import com.adb.stewart.tools.ToolOutcome
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.permissions.ApprovalCategory
import com.adb.stewart.tools.permissions.PermissionsSnapshot
import com.adb.stewart.tools.permissions.PromptResult
import com.adb.stewart.tools.permissions.SessionGrants
import com.adb.stewart.ui.ApprovalPrompter
import com.adb.stewart.ui.IdeApprovalGate
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

class ToolsE2ETest : BasePlatformTestCase() {

    private lateinit var scope: CoroutineScope
    private lateinit var session: ChatSession
    private lateinit var baseDir: File

    override fun setUp() {
        super.setUp()
        scope = CoroutineScope(SupervisorJob())
        session = ChatSession(project, scope)
        session.tools = { ProjectTools.registry(project, true) }
        session.autoCompactTokens = { 10_000_000 }
        baseDir = com.adb.stewart.tools.ProjectPaths.forProject(project).base.toFile()
        baseDir.mkdirs()
    }

    override fun tearDown() {
        try {
            scope.cancel()
        } finally {
            super.tearDown()
        }
    }

    private fun scripted(id: String = "fake", native: Boolean = false, vararg responses: List<ProviderEvent>) =
        object : ModelProvider {
            override val id = id
            val requests = mutableListOf<ChatRequest>()
            var calls = 0
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun supportsNativeTools(model: String) = native
            override fun chat(request: ChatRequest): Flow<ProviderEvent> {
                requests += request
                val evs = responses.getOrElse(calls++) { listOf(ProviderEvent.Completed("stop", null)) }
                return flow { evs.forEach { emit(it) } }
            }
        }

    private fun shimCall(name: String, args: String) = ProviderEvent.TextDelta(
        "<tool_call>\n{\"name\":\"$name\",\"arguments\":$args}\n</tool_call>")

    private class L : ChatListener {
        val done = CountDownLatch(1)
        val failed = CountDownLatch(1)
        var failure: String? = null
        val toolCalls = mutableListOf<String>()
        val toolOutcomes = mutableListOf<ToolOutcome>()
        override fun onDelta(text: String) {}
        override fun onCompleted(usage: Usage?) { done.countDown() }
        override fun onFailed(message: String) { failure = message; failed.countDown() }
        override fun onCancelled() { done.countDown() }
        override fun onToolRequested(call: ToolCall) { toolCalls += call.name }
        override fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) { toolOutcomes += outcome }
    }

    private fun send(text: String, ref: ModelRef = ModelRef("fake", "m")): L {
        val l = L()
        session.send(text, ref, l)
        val deadline = System.currentTimeMillis() + 30_000
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

    fun `test native path readfile result fed back`() {
        file("f.txt", "hello")
        val provider = scripted("fake", true,
            listOf(
                ProviderEvent.NativeToolCalls(listOf(
                    RawToolCall("c1", "ReadFile", "{\"path\":\"f.txt\"}"))),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        session.toolPathOverrides = { mapOf("fake/m" to "NATIVE") }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        val l = send("go")
        assertTrue("failed: " + l.failure, l.done.count == 0L)
        assertEquals(listOf("ReadFile"), l.toolCalls)
        assertEquals(2, provider.requests.size)
        assertTrue(provider.requests[1].messages.any {
            it.role == Role.TOOL && it.content.contains("1: hello")
        })
        assertTrue(session.transcript.any { it.role == Role.TOOL })
    }

    fun `test shim path edit approved writes file`() {
        val f = file("e.txt", "aaa bbb")
        val provider = scripted("fake", false,
            listOf(
                shimCall("EditFile", "{\"path\":\"e.txt\",\"old_string\":\"aaa\",\"new_string\":\"ccc\"}"),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        val l = send("go")
        assertTrue("failed: " + l.failure, l.done.count == 0L)
        assertEquals("ccc bbb", f.readText())
    }

    fun `test shim path edit rejected does not write`() {
        val f = file("e.txt", "aaa bbb")
        val provider = scripted("fake", false,
            listOf(
                shimCall("EditFile", "{\"path\":\"e.txt\",\"old_string\":\"aaa\",\"new_string\":\"ccc\"}"),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Rejected("no") }
        val l = send("go")
        assertTrue("failed: " + l.failure, l.done.count == 0L)
        assertEquals("aaa bbb", f.readText())
        assertTrue(l.toolOutcomes.any { it is ToolOutcome.Rejected })
    }

    fun `test run terminal only when approved`() {
        val provider = scripted("fake", false,
            listOf(
                shimCall("RunTerminal", "{\"command\":\"touch ran.txt\"}"),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Rejected("no") }
        send("go")
        assertFalse(File(baseDir, "ran.txt").exists())

        val provider2 = scripted("fake", false,
            listOf(
                shimCall("RunTerminal", "{\"command\":\"touch ran.txt\"}"),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider2) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        send("again")
        assertTrue(File(baseDir, "ran.txt").exists())
    }

    fun `test trusted mode auto approves edit but prompts command`() {
        file("e.txt", "aaa")
        val prompts = mutableListOf<String>()
        session.providers = {
            listOf(scripted("fake", false,
                listOf(
                    shimCall("EditFile", "{\"path\":\"e.txt\",\"old_string\":\"aaa\",\"new_string\":\"ccc\"}"),
                    ProviderEvent.Completed("tool_calls", null),
                ),
                listOf(
                    shimCall("RunTerminal", "{\"command\":\"touch cmd.txt\"}"),
                    ProviderEvent.Completed("tool_calls", null),
                ),
                listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
            ))
        }
        session.approval = IdeApprovalGate(
            project,
            { PermissionsSnapshot(ticks = setOf(ApprovalCategory.EDITS)) },
            SessionGrants(),
            object : ApprovalPrompter {
                override suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): PromptResult {
                    prompts += "file"
                    return PromptResult(ApprovalDecision.Approved)
                }
                override suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): PromptResult {
                    prompts += "command"
                    return PromptResult(ApprovalDecision.Approved)
                }
                override suspend fun confirmGeneric(call: ToolCall): PromptResult {
                    prompts += "generic"
                    return PromptResult(ApprovalDecision.Approved)
                }
            },
        )
        send("go")
        assertEquals("ccc", File(baseDir, "e.txt").readText())
        assertTrue(File(baseDir, "cmd.txt").exists())
        assertEquals(listOf("command"), prompts)
    }

    fun `test stale preview fails without writing`() {
        val f = file("e.txt", "aaa")
        val provider = scripted("fake", false,
            listOf(
                shimCall("EditFile", "{\"path\":\"e.txt\",\"old_string\":\"aaa\",\"new_string\":\"ccc\"}"),
                ProviderEvent.Completed("tool_calls", null),
            ),
            listOf(ProviderEvent.TextDelta("done"), ProviderEvent.Completed("stop", null)),
        )
        session.providers = { listOf(provider) }
        session.approval = ApprovalGate { _, _ ->
            f.writeText("changed by reviewer")
            ApprovalDecision.Approved
        }
        send("go")
        assertEquals("changed by reviewer", f.readText())
    }

    fun `test claude cli path drives tool`() {
        file("f.txt", "claude-content")
        val fixtureDir = createTempDir()
        val recordDir = createTempDir()
        File(fixtureDir, "1.json").writeText(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"<tool_call>\\n{\\\"name\\\":\\\"ReadFile\\\",\\\"arguments\\\":{\\\"path\\\":\\\"f.txt\\\"}}\\n</tool_call>\"}}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n")
        File(fixtureDir, "last.json").writeText(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n")
        val fakeScript = File("src/test/resources/claude/fake-claude.sh").absoluteFile
        fakeScript.setExecutable(true)
        val claude = ClaudeProvider(cliPath = fakeScript.absolutePath, extraEnv = mapOf(
            "FAKE_RECORD" to recordDir.absolutePath,
            "FAKE_FIXTURE_DIR" to fixtureDir.absolutePath))
        session.providers = { listOf(claude) }
        session.approval = ApprovalGate { _, _ -> ApprovalDecision.Approved }
        val l = send("go", ModelRef("claude", "m"))
        assertTrue("failed: ${l.failure}", l.done.count == 0L)
        assertEquals(listOf("ReadFile"), l.toolCalls)
        val stdin2 = File(recordDir, "stdin-2")
        assertTrue(stdin2.exists())
        assertTrue(stdin2.readText().contains("claude-content"))
    }
}

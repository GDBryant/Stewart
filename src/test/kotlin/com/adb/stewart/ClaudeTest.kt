package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.Usage
import com.adb.stewart.provider.claude.ClaudeProvider
import com.adb.stewart.provider.claude.ClaudeTranscript
import com.adb.stewart.shim.ToolCallingProvider
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopListener
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolRegistry
import java.io.File
import java.nio.file.Files
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClaudeTranscriptTest {
    private fun u(t: String) = ChatMessage(Role.USER, t)

    @Test
    fun `single user verbatim`() {
        val (sys, stdin) = ClaudeTranscript.render(listOf(u("hello")))
        assertEquals("You are a helpful assistant.", sys)
        assertEquals("hello", stdin)
    }

    @Test
    fun `multi turn format and system join`() {
        val (sys, stdin) = ClaudeTranscript.render(listOf(
            ChatMessage(Role.SYSTEM, "s1"), ChatMessage(Role.SYSTEM, "s2"),
            u("q1"), ChatMessage(Role.ASSISTANT, "a1"), u("q2")))
        assertEquals("s1\n\ns2", sys)
        assertEquals(
            "The conversation so far is below. Reply as the assistant to the last user message.\n\n<user>\nq1\n</user>\n\n<assistant>\na1\n</assistant>\n\n<user>\nq2\n</user>",
            stdin)
    }

    @Test
    fun `tool role renders as user`() {
        val (_, stdin) = ClaudeTranscript.render(listOf(
            u("go"), ChatMessage(Role.TOOL, "res", toolCallId = "c1")))
        assertTrue(stdin.contains("<user>\nres\n</user>"))
    }
}

class ClaudeProviderTest {

    private val fakeFile = File("src/test/resources/claude/fake-claude.sh").absoluteFile
    private val fake = fakeFile.absolutePath
    private val fixtures = File("src/test/resources/claude").absolutePath

    private fun req() = ChatRequest("haiku", listOf(ChatMessage(Role.USER, "say ok")))

    private fun events(p: ClaudeProvider, r: ChatRequest = req()) = runBlocking {
        p.chat(r).toList()
    }

    private fun cliArgs() = mapOf("FAKE_FIXTURE" to "$fixtures/auth-stream.json")

    @Test
    fun `full lifecycle via fake cli`() {
        val rec = Files.createTempDirectory("aijb-rec-").toFile()
        fakeFile.setExecutable(true)
        val evs = runBlocking {
            ClaudeProvider(cliPath = fake, extraEnv = mapOf(
                "FAKE_RECORD" to rec.absolutePath,
                "FAKE_FIXTURE" to "$fixtures/auth-stream.json",
                "ANTHROPIC_API_KEY" to "sk-leak",
                "KEEP_ME" to "1",
            )).chat(req()).toList()
        }
        val argv = File(rec, "argv-1").readText()
        assertTrue(argv.contains("[-p]"))
        assertTrue(argv.contains("[--tools]\n[]"))
        assertTrue(argv.contains("[--model]\n[haiku]"))
        assertTrue(argv.contains("[--system-prompt-file]"))
        assertTrue(File(rec, "stdin-1").readText() == "say ok")
        val envText = File(rec, "env-1").readText()
        assertFalse(envText.contains("ANTHROPIC_API_KEY"))
        assertFalse(envText.contains("ANTHROPIC_AUTH_TOKEN"))
        assertTrue(envText.contains("KEEP_ME=1"))
        val sysPath = argv.lines().first { it.contains("/tmp/aijb-claude-prompt") }.trim('[', ']')
        assertFalse(File(sysPath).exists())
        val cwd = File(rec, "pwd-1").readText().trim()
        assertTrue(cwd.startsWith(System.getProperty("java.io.tmpdir")))
        assertTrue(File(rec, "sysprompt-1").readText() == "You are a helpful assistant.")
        assertFalse(File(cwd).exists())
        assertTrue(evs.last() is ProviderEvent.Completed)
        val done = evs.last() as ProviderEvent.Completed
        assertEquals("stop", done.finishReason)
    }

    private fun runCli(env: Map<String, String>, request: ChatRequest = req()): List<ProviderEvent> {
        return runBlocking {
            ClaudeProvider(cliPath = "/bin/sh", extraEnv = mapOf(
                "FAKE_FIXTURE" to "$fixtures/auth-stream.json") + env)
                .chat(request).toList()
        }
    }

    private fun withScript(env: Map<String, String>): List<ProviderEvent> {
        fakeFile.setExecutable(true)
        return runBlocking {
            ClaudeProvider(cliPath = fake, extraEnv = env).chat(req()).toList()
        }
    }

    @Test
    fun `isolation stream yields reasoning and text`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "$fixtures/isolation-stream.json"))
        assertTrue(evs.any { it is ProviderEvent.ReasoningDelta })
        assertTrue(evs.any { it is ProviderEvent.TextDelta })
        assertTrue(evs.last() is ProviderEvent.Completed)
    }

    @Test
    fun `bad model error result maps code`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "$fixtures/badmodel-stream.json", "FAKE_EXIT" to "1"))
        val failed = evs.filterIsInstance<ProviderEvent.Failed>()
        assertEquals(1, failed.size)
        assertEquals("model_unavailable", failed[0].code)
        assertTrue(evs.none { it is ProviderEvent.Completed })
    }

    @Test
    fun `nonzero exit with auth stderr`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "", "FAKE_EXIT" to "1", "FAKE_STDERR" to "Not logged in"))
        val f = evs.last() as ProviderEvent.Failed
        assertEquals("auth", f.code)
        assertTrue(f.message.contains("exited with code 1"))
    }

    @Test
    fun `zero exit without result is incomplete`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "/dev/null"))
        assertEquals("incomplete_stream", (evs.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `successful result then nonzero exit`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "$fixtures/auth-stream.json", "FAKE_EXIT" to "3"))
        assertEquals("cli_exit", (evs.last() as ProviderEvent.Failed).code)
        assertTrue(evs.none { it is ProviderEvent.Completed })
    }

    @Test
    fun `isolation violation on tools in init`() {
        val f = Files.createTempFile("aijb-viol", ".json").toFile()
        f.writeText("{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[\"Bash\"],\"mcp_servers\":[]}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}\n")
        val evs = withScript(mapOf("FAKE_FIXTURE" to f.absolutePath))
        assertEquals("isolation_violation", (evs.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `missing cli reports cli_not_found`() {
        val evs = events(ClaudeProvider(cliPath = "/no/such/cli-xyz"))
        val f = evs.single() as ProviderEvent.Failed
        assertEquals("cli_not_found", f.code)
        assertTrue(f.message.contains("/no/such/cli-xyz"))
    }

    @Test
    fun `native tools rejected`() {
        val evs = events(ClaudeProvider(cliPath = "/bin/echo"),
            req().copy(tools = listOf(ToolSpec("t", "d", JsonObject(emptyMap())))))
        assertEquals("native_tools_unsupported", (evs.single() as ProviderEvent.Failed).code)
    }

    @Test
    fun `listModels returns configured`() = runBlocking {
        assertEquals(listOf("sonnet", "opus", "haiku"), ClaudeProvider().listModels().map { it.ref.modelId })
    }

    @Test
    fun `cancellation kills process tree`() {
        val dir = Files.createTempDirectory("aijb-cancel-").toFile()
        fakeFile.setExecutable(true)
        val pidFile = java.io.File(dir, "pids.txt")
        val p = ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_SLEEP" to "300", "FAKE_CHILD" to "1", "FAKE_FIXTURE" to "/dev/null",
                "FAKE_PID_FILE" to pidFile.absolutePath),
            killGrace = 500.milliseconds)
        val job = kotlinx.coroutines.runBlocking {
            val j = launch { p.chat(req()).toList() }
            withTimeout(8000) { while (!pidFile.exists() || pidFile.readLines().size < 2) delay(50) }
            j.cancel()
            withTimeout(8000) { j.join() }
            j
        }
        assertTrue(job.isCompleted)
        val (cliPid, childPid) = pidFile.readLines().map { it.trim().toLong() }
        // Both the CLI and its background child must be gone shortly after cancellation.
        val deadline = System.currentTimeMillis() + 5000
        fun alive(pid: Long) = ProcessHandle.of(pid).map { it.isAlive }.orElse(false)
        while ((alive(cliPid) || alive(childPid)) && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertFalse("CLI process still alive", alive(cliPid))
        assertFalse("CLI child still alive", alive(childPid))
        dir.deleteRecursively()
    }

    @Test
    fun `loginStatus parses response`() = runBlocking {
        val p = ClaudeProvider(cliPath = "/bin/sh", extraEnv = mapOf(
            "FAKE_AUTH_JSON" to "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"enterprise\",\"email\":\"x@y\"}"))
        fakeFile.setExecutable(true)
        val p2 = ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_AUTH_JSON" to "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"enterprise\",\"email\":\"a@b.c\"}"))
        val s = p2.loginStatus()
        assertTrue(s.loggedIn)
        assertEquals("claude.ai", s.authMethod)
        assertEquals("enterprise", s.subscriptionType)
        assertTrue(s.detail == null || !s.detail!!.contains("@"))
    }

    @Test
    fun `loginStatus failure modes`() = runBlocking {
        fakeFile.setExecutable(true)
        assertFalse(ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_AUTH_JSON" to "{\"loggedIn\":false}")).loginStatus().loggedIn)
        assertFalse(ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_AUTH_JSON" to "garbage")).loginStatus().loggedIn)
        val missing = ClaudeProvider(cliPath = "/no/such/cli-xyz").loginStatus()
        assertFalse(missing.loggedIn)
        assertTrue(missing.detail!!.contains("cannot start"))
        val slow = ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_AUTH_SLEEP" to "10"),
            authTimeoutMillis = 800).loginStatus()
        assertFalse(slow.loggedIn)
        assertTrue(slow.detail!!.contains("timed out"))
    }

    @Test
    fun `end to end through shim and tool loop`() = runBlocking {
        val recDir = Files.createTempDirectory("aijb-e2e-").toFile()
        val fixDir = Files.createTempDirectory("aijb-e2efix-").toFile()
        File(fixDir, "1.json").writeText(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"<tool_call> {\\\"name\\\":\\\"get_key\\\",\\\"arguments\\\":{}} </tool_call>\"}}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n")
        File(fixDir, "2.json").writeText(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n")
        var ran = 0
        val tool = object : Tool {
            override val spec = ToolSpec("get_key", "d", JsonObject(emptyMap()))
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                ran++
                return "k-7"
            }
        }
        fakeFile.setExecutable(true)
        val claude = ClaudeProvider(cliPath = fake, extraEnv = mapOf(
            "FAKE_RECORD" to recDir.absolutePath, "FAKE_FIXTURE_DIR" to fixDir.absolutePath))
        val loop = ToolLoop(ToolCallingProvider(claude, ToolPath.SHIM),
            ToolRegistry(listOf(tool)), ApprovalGate { _, _ -> ApprovalDecision.Approved })
        val result = loop.run("m", listOf(ChatMessage(Role.USER, "go")), object : LoopListener {})
        assertEquals(1, ran)
        assertTrue(result is LoopResult.Completed)
        val stdin2 = File(recDir, "stdin-2").readText()
        assertTrue(stdin2.contains("k-7"))
    }

    @Test
    fun `single assistant message uses multi format`() {
        val (_, stdin) = ClaudeTranscript.render(listOf(ChatMessage(Role.ASSISTANT, "solo")))
        assertTrue(stdin.contains("<assistant>\nsolo\n</assistant>"))
    }

    @Test
    fun `auth status nonzero exit`() = runBlocking {
        fakeFile.setExecutable(true)
        val s = ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_AUTH_JSON" to "{\"loggedIn\":false}", "FAKE_AUTH_EXIT" to "2")).loginStatus()
        assertFalse(s.loggedIn)
        assertTrue(s.detail!!.contains("exit"))
    }

    @Test
    fun `auth status non object json`() = runBlocking {
        fakeFile.setExecutable(true)
        val s = ClaudeProvider(cliPath = fake,
            extraEnv = mapOf("FAKE_AUTH_JSON" to "[1]")).loginStatus()
        assertFalse(s.loggedIn)
        assertTrue(s.detail!!.contains("non-JSON"))
    }

    @Test
    fun `toolpaths override native when supported`() {
        val native = FakeNative()
        assertEquals(ToolPath.NATIVE, com.adb.stewart.shim.ToolPaths.resolve(native, "m", ToolPath.NATIVE))
    }

    private class FakeNative : com.adb.stewart.provider.ModelProvider {
        override val id = "n"
        override suspend fun listModels() = emptyList<com.adb.stewart.provider.ModelInfo>()
        override fun supportsNativeTools(model: String) = true
        override fun chat(request: ChatRequest) = kotlinx.coroutines.flow.flow<ProviderEvent> {}
    }

    @Test
    fun `refused tool stream completes`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "$fixtures/refused-tool-stream.json"))
        assertTrue(evs.any { it is ProviderEvent.TextDelta && it.text.contains("I can't create") })
        assertTrue(evs.last() is ProviderEvent.Completed)
    }

    @Test
    fun `executed tool result kills process`() {
        val f = Files.createTempFile("aijb-exec", ".json").toFile()
        f.writeText("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":false}]}}\n" +
            "{\"type\":\"result\",\"is_error\":false,\"usage\":{}}\n")
        val evs = withScript(mapOf("FAKE_FIXTURE" to f.absolutePath))
        assertEquals("isolation_violation", (evs.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `debug log records stdin and every stdout line`() {
        val dir = Files.createTempDirectory("aijb-claude-debug")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.configure(true, dir.toString())
        try {
            fakeFile.setExecutable(true)
            events(ClaudeProvider(cliPath = fake, extraEnv = cliArgs()))
            val content = debugLogContent(dir)
            val outgoing = content.lines().filter { it.contains("[outgoing]") }
            assertEquals(1, outgoing.size)
            assertTrue(outgoing[0].contains("[claude]"))
            assertTrue(outgoing[0].contains("[haiku]"))
            assertTrue(outgoing[0].contains("say ok"))
            val incoming = content.lines().filter { it.contains("[incoming]") }
            assertTrue(incoming.isNotEmpty())
            assertTrue(incoming.any { it.contains("content_block_delta") })
        } finally {
            sink.configure(false, "./log/debug_logs/")
        }
    }

    @Test
    fun `debug log captures stderr on cli failure`() {
        val dir = Files.createTempDirectory("aijb-claude-stderr")
        val sink = com.adb.stewart.debug.DebugLogSink
        sink.configure(true, dir.toString())
        try {
            val evs = withScript(mapOf("FAKE_FIXTURE" to "", "FAKE_EXIT" to "1", "FAKE_STDERR" to "boom-stderr"))
            assertTrue(evs.last() is ProviderEvent.Failed)
            val stderrLines = debugLogContent(dir).lines().filter { it.contains("[stderr]") }
            assertTrue(stderrLines.any { it.contains("boom-stderr") })
        } finally {
            sink.configure(false, "./log/debug_logs/")
        }
    }

    private fun debugLogContent(dir: java.nio.file.Path): String {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val files = Files.list(dir).use { it.toList() }
            if (files.isNotEmpty()) {
                return files.sortedBy { it.fileName.toString() }
                    .joinToString("\n") { Files.readString(it) }
            }
            Thread.sleep(10)
        }
        throw AssertionError("no debug log file was written")
    }
}

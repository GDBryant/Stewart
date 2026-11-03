package com.adb.stewart

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.Usage
import com.adb.stewart.provider.claude.ClaudeModels
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
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    fun `tool result without matching call renders unlabeled`() {
        val (_, stdin) = ClaudeTranscript.render(listOf(
            u("go"), ChatMessage(Role.TOOL, "res", toolCallId = "c1"), ChatMessage(Role.TOOL, "r2")))
        assertTrue(stdin.contains("<tool_result>\nres\n</tool_result>"))
        assertTrue(stdin.contains("<tool_result>\nr2\n</tool_result>"))
        assertFalse(stdin.contains("<user>\nres"))
    }

    @Test
    fun `assistant tool calls and results keep names and arguments`() {
        val args = buildJsonObject { put("path", "a.txt") }
        val (_, stdin) = ClaudeTranscript.render(listOf(
            u("go"),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                ToolCall("x1", "read_file", args), ToolCall("x2", "list", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "hello", toolCallId = "x1"),
            ChatMessage(Role.TOOL, "[]", toolCallId = "x2"),
            ChatMessage(Role.TOOL, "stray", toolCallId = "other-provider-id")))
        assertTrue(stdin.contains("[called tool read_file with arguments {\"path\":\"a.txt\"}]"))
        assertTrue(stdin.contains("[called tool list with arguments {}]"))
        assertTrue(stdin.contains("<tool_result tool=\"read_file\">\nhello\n</tool_result>"))
        assertTrue(stdin.contains("<tool_result tool=\"list\">\n[]\n</tool_result>"))
        assertTrue(stdin.contains("<tool_result>\nstray\n</tool_result>"))
        assertFalse(stdin.contains("<tool_call>"))
    }
}

class ClaudeModelsTest {

    @Test
    fun `display names map to family`() {
        assertEquals("sonnet", ClaudeModels.normalize("Sonnet 5.5"))
        assertEquals("opus", ClaudeModels.normalize("Opus 5.5"))
        assertEquals("haiku", ClaudeModels.normalize("Haiku 5.5"))
        assertEquals("opus", ClaudeModels.normalize("Claude Opus 5.5"))
        assertEquals("sonnet", ClaudeModels.normalize("claude  sonnet 4"))
    }

    @Test
    fun `already valid ids unchanged`() {
        assertEquals("sonnet", ClaudeModels.normalize("sonnet"))
        assertEquals("claude-haiku-5-5-20251001", ClaudeModels.normalize("claude-haiku-5-5-20251001"))
        assertEquals("sonnet[1m]", ClaudeModels.normalize("sonnet[1m]"))
        assertEquals("Sonnet", ClaudeModels.normalize("Sonnet"))
    }

    @Test
    fun `unknown spaced name hyphenates`() {
        assertEquals("my-custom-model", ClaudeModels.normalize("My  Custom   Model"))
        assertEquals("x", ClaudeModels.normalize("  x  "))
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
        val rec = Files.createTempDirectory("stewart-rec-").toFile()
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
        val sysPath = argv.lines().first { it.contains("/tmp/stewart-claude-prompt") }.trim('[', ']')
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
        val f = Files.createTempFile("stewart-viol", ".json").toFile()
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
    fun `listModels normalizes and dedups`() = runBlocking {
        val p = ClaudeProvider(models = listOf("Sonnet 5.5", "sonnet", "Claude Opus 5.5", "My Custom Model"))
        assertEquals(listOf("sonnet", "opus", "my-custom-model"), p.listModels().map { it.ref.modelId })
    }

    @Test
    fun `chat normalizes model in argv`() {
        val rec = Files.createTempDirectory("stewart-rec-").toFile()
        fakeFile.setExecutable(true)
        runBlocking {
            ClaudeProvider(cliPath = fake, extraEnv = mapOf(
                "FAKE_RECORD" to rec.absolutePath,
                "FAKE_FIXTURE" to "$fixtures/auth-stream.json",
            )).chat(req().copy(model = "Sonnet 5.5")).toList()
        }
        assertTrue(File(rec, "argv-1").readText().contains("[--model]\n[sonnet]"))
    }

    @Test
    fun `cancellation kills process tree`() {
        val dir = Files.createTempDirectory("stewart-cancel-").toFile()
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
        val recDir = Files.createTempDirectory("stewart-e2e-").toFile()
        val fixDir = Files.createTempDirectory("stewart-e2efix-").toFile()
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
    fun `refused tool stream cuts at offered tool_use`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "$fixtures/refused-tool-stream.json"))
        val calls = evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(listOf("bash"), calls.map { it.name })
        assertTrue(evs.none { it is ProviderEvent.TextDelta && it.text.contains("I can't create") })
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
        assertEquals(Usage(4568, 300), (evs.last() as ProviderEvent.Completed).usage)
    }

    private fun parallelFixture(): File {
        val f = Files.createTempFile("stewart-par-", ".json").toFile()
        fun se(t: String, m: String = "m1") = "{\"type\":\"stream_event\",\"event\":{\"type\":\"$t\"},\"api_message_id\":\"$m\"}"
        fun tu(id: String, n: String) = "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$id\",\"name\":\"$n\",\"input\":{}}]}}"
        fun er(id: String) = "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$id\",\"is_error\":true}]}}"
        f.writeText(listOf(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"plan\"}},\"api_message_id\":\"m1\"}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"plan\"}]}}",
            tu("t1", "a"), er("t1"), se("content_block_stop"), tu("t2", "b"), er("t2"),
            se("message_delta"), se("message_stop"),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"content\":[{\"type\":\"text\",\"text\":\"refusal\"}]}}",
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}",
        ).joinToString("\n", postfix = "\n"))
        return f
    }

    @Test
    fun `parallel tool_use blocks reach provider once each with one completion`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to parallelFixture().absolutePath))
        assertEquals(listOf("t1", "t2"), evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }.map { it.id })
        assertEquals(listOf("plan"), evs.filterIsInstance<ProviderEvent.TextDelta>().map { it.text })
        assertEquals(1, evs.count { it is ProviderEvent.Completed })
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
        assertTrue(evs.none { it is ProviderEvent.Failed })
        assertNull((evs.last() as ProviderEvent.Completed).usage)
    }

    @Test
    fun `tool turn cut kills a cli that keeps running`() {
        val pidFile = Files.createTempFile("stewart-pid-", ".txt").toFile()
        val evs = runBlocking {
            withTimeout(10.seconds) {
                fakeFile.setExecutable(true)
                ClaudeProvider(cliPath = fake, extraEnv = mapOf(
                    "FAKE_FIXTURE" to "$fixtures/tooluse-stream.json", "FAKE_SLEEP_AFTER" to "60",
                    "FAKE_CHILD" to "1", "FAKE_PID_FILE" to pidFile.absolutePath)).chat(req()).toList()
            }
        }
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
        val pids = pidFile.readLines().filter { it.isNotBlank() }.map { it.trim().toLong() }
        runBlocking { delay(200) }
        for (pid in pids) assertFalse(ProcessHandle.of(pid).map { it.isAlive }.orElse(false))
    }

    @Test
    fun `clean eof after rejected tool_use completes with tool_calls`() {
        val f = Files.createTempFile("stewart-eof-", ".json").toFile()
        f.writeText(
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"a\",\"input\":{}}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true}]}}\n")
        val evs = withScript(mapOf("FAKE_FIXTURE" to f.absolutePath))
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
        assertNull((evs.last() as ProviderEvent.Completed).usage)
        assertEquals(1, evs.count { it is ProviderEvent.Completed })
        f.writeText(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":6,\"output_tokens\":1}}}}\n" +
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"a\",\"input\":{}}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true}]}}\n")
        assertEquals(Usage(6, 1), (withScript(mapOf("FAKE_FIXTURE" to f.absolutePath)).last() as ProviderEvent.Completed).usage)
        // Negative: a tool_use with no rejection and no result is still an incomplete stream.
        f.writeText(
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"a\",\"input\":{}}]}}\n")
        val bad = withScript(mapOf("FAKE_FIXTURE" to f.absolutePath))
        assertEquals("incomplete_stream", (bad.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `cross provider tool history reaches claude through shim and raw paths`() = runBlocking {
        fakeFile.setExecutable(true)
        val history = listOf(
            ChatMessage(Role.USER, "go"),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                ToolCall("ollama-1", "get_key", buildJsonObject { put("a", 1) }))),
            ChatMessage(Role.TOOL, "k-7", toolCallId = "ollama-1"),
            ChatMessage(Role.TOOL, "orphan", toolCallId = "aif-x"),
            ChatMessage(Role.USER, "next"))
        val spec = ToolSpec("get_key", "d", buildJsonObject { put("type", "object") })
        val rec = Files.createTempDirectory("stewart-xp-").toFile()
        val claude = ClaudeProvider(cliPath = fake, extraEnv = mapOf(
            "FAKE_RECORD" to rec.absolutePath, "FAKE_FIXTURE" to "$fixtures/auth-stream.json"))
        ToolCallingProvider(claude, ToolPath.SHIM).chat(ChatRequest("m", history, tools = listOf(spec))).toList()
        val shim = File(rec, "stdin-1").readText()
        assertTrue(shim.contains("{\"name\":\"get_key\",\"arguments\":{\"a\":1}}"))
        assertTrue(shim.contains("{\"name\":\"get_key\",\"content\":\"k-7\"}"))
        assertTrue(shim.contains("{\"name\":\"unknown\",\"content\":\"orphan\"}"))
        ToolCallingProvider(claude, ToolPath.SHIM).chat(ChatRequest("m", history)).toList()
        val raw = File(rec, "stdin-2").readText()
        assertTrue(raw.contains("[called tool get_key with arguments {\"a\":1}]"))
        assertTrue(raw.contains("<tool_result tool=\"get_key\">\nk-7\n</tool_result>"))
        assertTrue(raw.contains("<tool_result>\norphan\n</tool_result>"))
    }

    @Test
    fun `model tool_use surfaces as native call`() {
        val evs = withScript(mapOf("FAKE_FIXTURE" to "$fixtures/tooluse-stream.json"))
        val calls = evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(1, calls.size)
        assertEquals("submit_plan", calls[0].name)
        assertEquals("toolu_1", calls[0].id)
        assertTrue(calls[0].arguments.contains("\"goal\":\"g\""))
        val done = evs.last() as ProviderEvent.Completed
        assertEquals("tool_calls", done.finishReason)
        assertTrue(evs.none { it is ProviderEvent.TextDelta && it.text.contains("call failed") })
    }

    @Test
    fun `shim cuts the cli turn at an offered tool_use`() = runBlocking {
        fakeFile.setExecutable(true)
        val claude = ClaudeProvider(cliPath = fake, extraEnv = mapOf("FAKE_FIXTURE" to "$fixtures/tooluse-stream.json"))
        val spec = ToolSpec("submit_plan", "d", buildJsonObject { put("type", "object") })
        val evs = ToolCallingProvider(claude, ToolPath.SHIM)
            .chat(ChatRequest("m", listOf(ChatMessage(Role.USER, "go")), tools = listOf(spec))).toList()
        val call = evs.filterIsInstance<ProviderEvent.ToolCalls>().single().calls.single()
        assertEquals("submit_plan", call.name)
        assertEquals("g", call.arguments["goal"]?.jsonPrimitive?.content)
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
        assertTrue(evs.any { it is ProviderEvent.TextDelta && it.text.contains("I will submit the plan.") })
        assertTrue(evs.none { it is ProviderEvent.TextDelta && it.text.contains("call failed") })
    }

    @Test
    fun `end to end native tool_use through shim and tool loop`() = runBlocking {
        val recDir = Files.createTempDirectory("stewart-e2e-").toFile()
        val fixDir = Files.createTempDirectory("stewart-e2efix-").toFile()
        File(fixDir, "1.json").writeText(
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[" +
                "{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"get_key\",\"input\":{\"a\":1}}]}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n")
        File(fixDir, "2.json").writeText(
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n")
        var ran = 0
        var seenA: kotlinx.serialization.json.JsonElement? = null
        val tool = object : Tool {
            override val spec = ToolSpec("get_key", "d", buildJsonObject {
                put("type", "object")
                put("properties", buildJsonObject { put("a", buildJsonObject { put("type", "integer") }) })
            })
            override val requiresApproval = false
            override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
                ran++
                seenA = arguments["a"]
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
        assertEquals(1, seenA?.jsonPrimitive?.intOrNull)
        assertTrue(result is LoopResult.Completed)
        val stdin2 = File(recDir, "stdin-2").readText()
        assertTrue(stdin2.contains("k-7"))
        assertTrue(stdin2.contains("<tool_response>\n{\"name\":\"get_key\""))
        assertTrue(stdin2.contains("<assistant>\n<tool_call>\n{\"name\":\"get_key\",\"arguments\":{\"a\":1}}"))
    }

    @Test
    fun `unoffered native tool_use is passed on as an unknown call through shim`() = runBlocking {
        val fixDir = Files.createTempDirectory("stewart-e2efix-").toFile()
        File(fixDir, "1.json").writeText(
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[" +
                "{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"bash\",\"input\":{}}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[" +
                "{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true,\"content\":\"No such tool available\"}]}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}\n")
        fakeFile.setExecutable(true)
        val claude = ClaudeProvider(cliPath = fake, extraEnv = mapOf(
            "FAKE_FIXTURE_DIR" to fixDir.absolutePath,
            "FAKE_RECORD" to Files.createTempDirectory("stewart-e2e-").toFile().absolutePath))
        val evs = ToolCallingProvider(claude, ToolPath.SHIM)
            .chat(ChatRequest("m", listOf(ChatMessage(Role.USER, "go")),
                tools = listOf(ToolSpec("get_key", "d", JsonObject(emptyMap()))))).toList()
        // ToolLoop answers it with "unknown tool" so the model can recover instead of the run failing.
        assertTrue(evs.none { it is ProviderEvent.Failed })
        assertEquals(listOf("bash"), evs.filterIsInstance<ProviderEvent.ToolCalls>().single().calls.map { it.name })
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
    }

    @Test
    fun `parallel tool_use across assistant events surfaces all calls`() {
        val f = Files.createTempFile("stewart-par", ".json").toFile()
        f.writeText(
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[" +
                "{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"a\",\"input\":{\"x\":1}}]}}\n" +
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[" +
                "{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"b\",\"input\":{\"y\":2}}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[" +
                "{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true,\"content\":\"No such tool available\"}," +
                "{\"type\":\"tool_result\",\"tool_use_id\":\"t2\",\"is_error\":true,\"content\":\"No such tool available\"}]}}\n" +
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}\n")
        val evs = withScript(mapOf("FAKE_FIXTURE" to f.absolutePath))
        val calls = evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(listOf("a", "b"), calls.map { it.name })
        assertEquals("tool_calls", (evs.last() as ProviderEvent.Completed).finishReason)
    }

    @Test
    fun `executed tool result kills process`() {
        val f = Files.createTempFile("stewart-exec", ".json").toFile()
        f.writeText("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":false}]}}\n" +
            "{\"type\":\"result\",\"is_error\":false,\"usage\":{}}\n")
        val evs = withScript(mapOf("FAKE_FIXTURE" to f.absolutePath))
        assertEquals("isolation_violation", (evs.last() as ProviderEvent.Failed).code)
    }

    @Test
    fun `debug log records stdin and every stdout line`() {
        val dir = Files.createTempDirectory("stewart-claude-debug")
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
        val dir = Files.createTempDirectory("stewart-claude-stderr")
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

class SupportsImagesTest {
    @Test
    fun `claude supports images for every model`() {
        val p = com.adb.stewart.provider.claude.ClaudeProvider()
        assertTrue(p.supportsImages("sonnet"))
        assertTrue(p.supportsImages("anything-else"))
    }

    @Test
    fun `interface default is false`() {
        val p = object : com.adb.stewart.provider.ModelProvider {
            override val id = "x"
            override suspend fun listModels() = emptyList<com.adb.stewart.provider.ModelInfo>()
            override fun chat(request: com.adb.stewart.provider.ChatRequest) =
                kotlinx.coroutines.flow.emptyFlow<com.adb.stewart.provider.ProviderEvent>()
        }
        org.junit.Assert.assertFalse(p.supportsImages("m"))
    }
}

package com.aijb.assistant

import com.aijb.assistant.chat.CommandContext
import com.aijb.assistant.chat.GitDiff
import com.aijb.assistant.chat.SlashCommands.ReviewRequest
import com.aijb.assistant.chat.SlashCommands
import com.aijb.assistant.chat.SlashCommands.ModelMatch
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Usage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SlashCommandsTest {

    private class FakeContext(override var running: Boolean = false) : CommandContext {
        val shown = mutableListOf<String>()
        val errors = mutableListOf<String>()
        override fun show(text: String) {
            shown += text
        }
        override fun error(text: String) {
            errors += text
        }
        override var usage: Usage? = null
        override var models: List<ModelInfo> = emptyList()
        override var currentModel: ModelInfo? = null
        var cleared = 0
        var settingsOpened = 0
        var pickerOpened = 0
        override fun clear() {
            cleared++
        }
        override fun openSettings() {
            settingsOpened++
        }
        override fun selectModel(model: ModelInfo) {
            currentModel = model
        }
        override fun openModelPicker() {
            pickerOpened++
        }
        val compactions = mutableListOf<String?>()
        var compactStarts = true
        override fun compact(focus: String?): Boolean {
            compactions += focus
            return compactStarts
        }
        val prompts = mutableListOf<String>()
        val reviews = mutableListOf<String?>()
        var accepts = true
        override fun sendPrompt(prompt: String): Boolean {
            prompts += prompt
            return accepts
        }
        override fun review(focus: String?): Boolean {
            reviews += focus
            return accepts
        }
    }

    private fun run(ctx: FakeContext, input: String): Boolean = SlashCommands.execute(SlashCommands.parse(input)!!, ctx)

    private fun info(provider: String, model: String) = ModelInfo(ModelRef(provider, model), model)

    private val ollamaQwen = info("ollama", "qwen")
    private val aifQwen = info("aif", "qwen")
    private val aifGlm = info("aif", "glm")

    @Test
    fun `parse splits name and args`() {
        assertEquals(SlashCommands.Parsed("compact", "keep the api notes"), SlashCommands.parse("/compact keep the api notes"))
    }

    @Test
    fun `parse trims extra whitespace around args`() {
        assertEquals(SlashCommands.Parsed("model", "a/b"), SlashCommands.parse("/model   a/b  \n"))
        assertEquals(SlashCommands.Parsed("help", ""), SlashCommands.parse("/help"))
        assertEquals(SlashCommands.Parsed("help", ""), SlashCommands.parse("/help\n"))
    }

    @Test
    fun `parse lowercases the name but not the args`() {
        assertEquals(SlashCommands.Parsed("help", "X"), SlashCommands.parse("/HeLp X"))
    }

    @Test
    fun `leading whitespace double slash and mid text slash are not commands`() {
        assertNull(SlashCommands.parse(" /help"))
        assertNull(SlashCommands.parse("//help"))
        assertNull(SlashCommands.parse("see a/b and /help"))
        assertNull(SlashCommands.parse(""))
    }

    @Test
    fun `double slash escapes to a single slash and other text is unchanged`() {
        assertEquals("/help me", SlashCommands.plainText("//help me"))
        assertEquals("a /b", SlashCommands.plainText("a /b"))
        assertEquals(" /x", SlashCommands.plainText(" /x"))
    }

    @Test
    fun `a lone slash is an unknown command`() {
        val parsed = SlashCommands.parse("/")!!
        assertEquals("", parsed.name)
        val ctx = FakeContext()
        assertFalse(SlashCommands.execute(parsed, ctx))
        assertEquals(listOf("Unknown command / — type /help"), ctx.errors)
    }

    @Test
    fun `unknown command reports an error and shows nothing`() {
        val ctx = FakeContext()
        assertFalse(SlashCommands.execute(SlashCommands.parse("/nope x")!!, ctx))
        assertEquals(listOf("Unknown command /nope — type /help"), ctx.errors)
        assertTrue(ctx.shown.isEmpty())
    }

    @Test
    fun `help lists every registered command`() {
        val ctx = FakeContext()
        assertTrue(SlashCommands.execute(SlashCommands.parse("/help")!!, ctx))
        val text = ctx.shown.single()
        SlashCommands.all.forEach { assertTrue(it.name, text.contains("/${it.name}")) }
        assertTrue(ctx.errors.isEmpty())
    }

    @Test
    fun `help runs while a run is active`() {
        val ctx = FakeContext(running = true)
        assertTrue(SlashCommands.execute(SlashCommands.parse("/help")!!, ctx))
        assertEquals(1, ctx.shown.size)
    }

    @Test
    fun `find returns null for an unknown name`() {
        assertNull(SlashCommands.find("nope"))
        assertEquals("help", SlashCommands.find("help")!!.name)
    }

    @Test
    fun `clear clears and is blocked while running`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/clear"))
        assertEquals(1, ctx.cleared)
        ctx.running = true
        assertFalse(run(ctx, "/clear"))
        assertEquals(1, ctx.cleared)
        assertEquals(listOf("/clear is not available while running"), ctx.errors)
    }

    @Test
    fun `cost with no usage says so`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/cost"))
        assertEquals(listOf("No usage yet"), ctx.shown)
    }

    @Test
    fun `cost formats session usage and runs while running`() {
        val ctx = FakeContext(running = true)
        ctx.usage = Usage(10, 5, 0.25)
        assertTrue(run(ctx, "/cost"))
        assertEquals(listOf("Session: tokens 10 in / 5 out · cost $0.2500"), ctx.shown)
    }

    @Test
    fun `config opens settings and is blocked while running`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/config"))
        assertEquals(1, ctx.settingsOpened)
        ctx.running = true
        assertFalse(run(ctx, "/config"))
        assertEquals(1, ctx.settingsOpened)
    }

    @Test
    fun `model without args shows the current model and opens the picker`() {
        val ctx = FakeContext()
        ctx.currentModel = aifGlm
        assertTrue(run(ctx, "/model"))
        assertEquals(listOf("Model: aif/glm"), ctx.shown)
        assertEquals(1, ctx.pickerOpened)
    }

    @Test
    fun `model without args and no selection reports it and opens the picker`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/model"))
        assertEquals(listOf("No model selected"), ctx.errors)
        assertEquals(1, ctx.pickerOpened)
    }

    @Test
    fun `model switches on an exact ref or a unique bare id`() {
        val ctx = FakeContext()
        ctx.models = listOf(ollamaQwen, aifQwen, aifGlm)
        assertTrue(run(ctx, "/model aif/qwen"))
        assertEquals(aifQwen, ctx.currentModel)
        assertTrue(run(ctx, "/model glm"))
        assertEquals(aifGlm, ctx.currentModel)
        assertEquals(listOf("Model: aif/qwen", "Model: aif/glm"), ctx.shown)
    }

    @Test
    fun `model with an ambiguous id lists the candidates and keeps the selection`() {
        val ctx = FakeContext()
        ctx.models = listOf(ollamaQwen, aifQwen, aifGlm)
        ctx.currentModel = aifGlm
        assertFalse(run(ctx, "/model qwen"))
        assertEquals(listOf("Model qwen is ambiguous: ollama/qwen, aif/qwen"), ctx.errors)
        assertEquals(aifGlm, ctx.currentModel)
    }

    @Test
    fun `model with an unknown name lists what is available`() {
        val ctx = FakeContext()
        assertFalse(run(ctx, "/model x"))
        ctx.models = listOf(aifGlm)
        assertFalse(run(ctx, "/model x"))
        assertEquals(
            listOf("Unknown model x. Available: none loaded", "Unknown model x. Available: aif/glm"),
            ctx.errors,
        )
    }

    @Test
    fun `model is blocked while running`() {
        val ctx = FakeContext(running = true)
        ctx.models = listOf(aifGlm)
        assertFalse(run(ctx, "/model glm"))
        assertNull(ctx.currentModel)
    }

    @Test
    fun `matchModel prefers the exact ref`() {
        // "a/b" is both z's bare model id and a's exact ref.
        val models = listOf(info("z", "a/b"), info("a", "b"))
        assertEquals(ModelMatch.Found(models[1]), SlashCommands.matchModel("a/b", models))
        assertEquals(ModelMatch.NotFound, SlashCommands.matchModel("", models))
    }

    @Test
    fun `compact passes the focus or null`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/compact"))
        assertTrue(run(ctx, "/compact  the api  "))
        assertEquals(listOf(null, "the api"), ctx.compactions)
    }

    @Test
    fun `compact keeps the input when it cannot start and is blocked while running`() {
        val ctx = FakeContext()
        ctx.compactStarts = false
        assertFalse(run(ctx, "/compact"))
        ctx.running = true
        assertFalse(run(ctx, "/compact"))
        assertEquals(1, ctx.compactions.size)
    }

    @Test
    fun `init sends the canned prompt and keeps the input when it cannot`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/init"))
        assertEquals(listOf(SlashCommands.INIT_PROMPT), ctx.prompts)
        assertTrue(SlashCommands.INIT_PROMPT.contains("AGENTS.md"))
        ctx.accepts = false
        assertFalse(run(ctx, "/init"))
        ctx.running = true
        assertFalse(run(ctx, "/init"))
        assertEquals(2, ctx.prompts.size)
    }

    @Test
    fun `review passes the focus and is blocked while running`() {
        val ctx = FakeContext()
        assertTrue(run(ctx, "/review"))
        assertTrue(run(ctx, "/review security"))
        ctx.running = true
        assertFalse(run(ctx, "/review"))
        assertEquals(listOf(null, "security"), ctx.reviews)
    }

    @Test
    fun `review prompt inlines the diff and the focus`() {
        val diff = "diff --git a/x b/x\n+hello\n"
        val prompt = (SlashCommands.reviewRequest(GitDiff.Result.Diff(diff), " auth ") as ReviewRequest.Send).prompt
        assertTrue(prompt.contains("```diff\n$diff```"))
        assertTrue(prompt.contains("Focus on: auth\n"))
        assertFalse(prompt.contains("truncated"))
    }

    @Test
    fun `review prompt without focus closes a diff lacking a final newline`() {
        val prompt = (SlashCommands.reviewRequest(GitDiff.Result.Diff("+x"), null) as ReviewRequest.Send).prompt
        assertTrue(prompt.endsWith("```diff\n+x\n```"))
        assertFalse(prompt.contains("Focus on"))
    }

    @Test
    fun `review prompt truncates a large diff and says so`() {
        val prompt = (SlashCommands.reviewRequest(GitDiff.Result.Diff("a".repeat(30)), null, maxChars = 10)
            as ReviewRequest.Send).prompt
        assertTrue(prompt.contains("a".repeat(10) + "\n```"))
        assertFalse(prompt.contains("a".repeat(11)))
        assertTrue(prompt.endsWith("[diff truncated: 20 of 30 chars omitted; read the files for the rest]"))
    }

    @Test
    fun `review without changes or a repo shows a message and sends nothing`() {
        assertEquals(ReviewRequest.Message("No changes to review", false), SlashCommands.reviewRequest(GitDiff.Result.NoChanges, null))
        assertEquals(
            ReviewRequest.Message("No commits yet: nothing to diff against", true),
            SlashCommands.reviewRequest(GitDiff.Result.NoCommits, null),
        )
        assertEquals(
            ReviewRequest.Message("Cannot review: Not a git repository", true),
            SlashCommands.reviewRequest(GitDiff.Result.NotRepo("Not a git repository"), null),
        )
    }

    @Test
    fun `complete filters by prefix case insensitively`() {
        assertEquals(listOf("clear", "cost", "compact", "config"), SlashCommands.complete("/c").map { it.name })
        assertEquals(listOf("cost", "compact", "config"), SlashCommands.complete("/CO").map { it.name })
        assertEquals(listOf("help"), SlashCommands.complete("/help").map { it.name })
        assertEquals(SlashCommands.all, SlashCommands.complete("/"))
    }

    @Test
    fun `complete is empty for no match, a space, plain text and the escape`() {
        assertTrue(SlashCommands.complete("/zz").isEmpty())
        assertTrue(SlashCommands.complete("/help ").isEmpty())
        assertTrue(SlashCommands.complete("help").isEmpty())
        assertTrue(SlashCommands.complete("//h").isEmpty())
        assertTrue(SlashCommands.complete("").isEmpty())
    }
}

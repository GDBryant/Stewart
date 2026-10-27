package com.aijb.assistant

import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.claude.ClaudeStreamParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClaudeStreamParserTest {

    private fun feed(p: ClaudeStreamParser, vararg lines: String) =
        lines.flatMap { p.feed(it) }

    @Test
    fun `init with mcp servers is violation`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, "{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[],\"mcp_servers\":[\"x\"]}")
        assertEquals("isolation_violation", (evs.single() as ProviderEvent.Failed).code)
    }

    @Test
    fun `init ok and other system subtypes ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[],\"mcp_servers\":[]}",
            "{\"type\":\"system\",\"subtype\":\"status\"}",
            "{\"type\":\"system\",\"subtype\":\"ui_invalidate\"}").isEmpty())
    }

    @Test
    fun `user event with error tool_result ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":true}]}}",
            "{\"type\":\"user\",\"message\":{}}").isEmpty())
    }

    @Test
    fun `user event with non error tool_result is violation`() {
        val p = ClaudeStreamParser()
        assertEquals("isolation_violation",
            (feed(p, "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":false}]}}").single()
                as ProviderEvent.Failed).code)
    }

    @Test
    fun `content block start tool_use is not violation`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"name\":\"bash\"}}}").isEmpty())
    }

    @Test
    fun `server_tool_use only advisor allowed`() {
        var p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"server_tool_use\",\"name\":\"advisor\"}}}").isEmpty())
        p = ClaudeStreamParser()
        assertEquals("isolation_violation", (feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"server_tool_use\",\"name\":\"web_search\"}}}").single()
            as ProviderEvent.Failed).code)
    }

    @Test
    fun `content block start text is fine`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}").isEmpty())
    }

    @Test
    fun `assistant tool_use ignored server tool gated`() {
        var p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"name\":\"bash\"}]}}").isEmpty())
        p = ClaudeStreamParser()
        assertEquals("isolation_violation", (feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"server_tool_use\",\"name\":\"web_fetch\"}]}}").single()
            as ProviderEvent.Failed).code)
        p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"server_tool_use\",\"name\":\"advisor\"}]}}").isEmpty())
    }

    @Test
    fun `partial plus assistant dedupe`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            "{\"type\":\"stream_event\",\"api_message_id\":\"m1\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"content\":[{\"type\":\"text\",\"text\":\"dup\"},{\"type\":\"thinking\",\"thinking\":\"th\"}]}}")
        assertEquals(listOf(
            ProviderEvent.TextDelta("hi"), ProviderEvent.TextDelta("dup"), ProviderEvent.ReasoningDelta("th")), evs)
    }

    @Test
    fun `message delta stop reason and finish mapping`() {
        val p = ClaudeStreamParser()
        feed(p, "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}}",
            "{\"type\":\"result\",\"is_error\":false,\"usage\":{\"input_tokens\":3}}")
        assertEquals("length", p.finishReason)
        assertEquals(3, p.usage?.promptTokens)
    }

    @Test
    fun `usage sums cache tokens`() {
        val p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":10,\"cache_read_input_tokens\":20,\"output_tokens\":5}}")
        assertEquals(32, p.usage?.promptTokens)
        assertEquals(5, p.usage?.completionTokens)
        assertEquals("stop", p.finishReason)
    }

    @Test
    fun `refusal and unknown stop reasons`() {
        var p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"refusal\",\"usage\":{}}")
        assertEquals("content_filter", p.finishReason)
        p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"weird\",\"usage\":{}}")
        assertEquals("weird", p.finishReason)
    }

    @Test
    fun `error result uses result message and classify`() {
        for ((msg, code) in listOf(
            "Not logged in" to "auth",
            "token expired yesterday" to "auth",
            "issue with the selected model" to "model_unavailable",
            "rate limit hit" to "rate_limited",
            "usage limit reached" to "rate_limited",
            "something else" to "cli_error",
        )) {
            val p = ClaudeStreamParser()
            val evs = feed(p, "{\"type\":\"result\",\"is_error\":true,\"result\":\"$msg\"}")
            val f = evs.single() as ProviderEvent.Failed
            assertEquals(msg, code, f.code)
            assertEquals(msg, f.message)
        }
        val p = ClaudeStreamParser()
        val f = feed(p, "{\"type\":\"result\",\"is_error\":true}").single() as ProviderEvent.Failed
        assertEquals("Claude CLI error", f.message)
    }

    @Test
    fun `lines after result and non json ignored`() {
        val p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{}}",
            "not json", "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}}")
        assertTrue(feed(p, "123", "[]", "{\"type\":\"other\"}").isEmpty())
    }

    @Test
    fun `stream event without deltas`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\"}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\"}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"signature_delta\",\"signature\":\"s\"}}}",
            "{\"type\":\"stream_event\"}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\"}}}").isEmpty())
    }

    @Test
    fun `stream event message id dedupes assistant`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"message\":{\"id\":\"mid1\"},\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"mid1\",\"content\":[{\"type\":\"text\",\"text\":\"x\"}]}}")
        assertEquals(listOf(ProviderEvent.TextDelta("x")), evs)
    }

    @Test
    fun `delta variants and missing fields`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\"}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\"}}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\"}}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\"}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\"}}",
            "{\"type\":\"assistant\"}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"z\"}}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"z\",\"content\":[1,{\"type\":\"other\"}]}}").isEmpty())
    }

    @Test
    fun `result without is_error is success`() {
        val p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"usage\":{\"output_tokens\":2}}")
        assertTrue(p.resultSeen && !p.resultIsError)
        assertNull(p.finishReason)
        assertEquals(0, p.usage?.promptTokens)
        assertEquals(2, p.usage?.completionTokens)
    }

    @Test
    fun `refused tool fixture parses cleanly`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, *java.io.File("src/test/resources/claude/refused-tool-stream.json").readLines().toTypedArray())
        assertTrue(evs.none { it is ProviderEvent.Failed })
        assertTrue(evs.any { it is ProviderEvent.TextDelta && it.text.contains("I can't") || it is ProviderEvent.TextDelta })
        assertTrue(p.resultSeen && !p.resultIsError)
        assertEquals("stop", p.finishReason)
    }

    @Test
    fun `result is_error as boolean`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, "{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}")
        assertEquals("cli_error", (evs.single() as ProviderEvent.Failed).code)
    }
}

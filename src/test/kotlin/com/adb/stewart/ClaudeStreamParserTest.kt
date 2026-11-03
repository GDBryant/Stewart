package com.adb.stewart

import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.claude.ClaudeStreamParser
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
    fun `error tool_result after tool_use ends the turn`() {
        val p = ClaudeStreamParser()
        feed(p, "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"x\",\"input\":{}}]}}")
        assertTrue(feed(p,
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t\",\"is_error\":true,\"content\":\"No such tool available\"}]}}").isEmpty())
        assertTrue(p.cutPending && !p.toolTurnEnded)
        assertEquals("tool_calls", p.finishReason)
        assertTrue(feed(p, "{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"content\":[{\"type\":\"text\",\"text\":\"sorry\"}]}}").isEmpty())
        assertTrue(p.toolTurnEnded)
        assertTrue(feed(p, "{\"type\":\"result\",\"is_error\":true,\"result\":\"x\"}").isEmpty())
    }

    private fun tu(id: String?, name: String, msg: String? = "m1") =
        "{\"type\":\"assistant\",\"message\":{" + (msg?.let { "\"id\":\"$it\"," } ?: "") +
            "\"content\":[{\"type\":\"tool_use\"," + (id?.let { "\"id\":\"$it\"," } ?: "") +
            "\"name\":\"$name\",\"input\":{\"k\":\"$name\"}}]}}"

    private fun err(id: String) =
        "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$id\",\"is_error\":true}]}}"

    private fun se(type: String, extra: String = "", msg: String = "m1") =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"$type\"$extra},\"api_message_id\":\"$msg\"}"

    private fun start(msg: String, usage: String) =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"$msg\",\"usage\":$usage}}}"

    private fun mdelta(msg: String, usage: String) =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":$usage},\"api_message_id\":\"$msg\"}"

    @Test
    fun `cut turn takes usage from the stream without double counting`() {
        val p = ClaudeStreamParser()
        feed(p,
            start("m1", "{\"input_tokens\":5,\"cache_creation_input_tokens\":10,\"cache_read_input_tokens\":100,\"output_tokens\":1}"),
            tu("t1", "a"),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":5,\"cache_creation_input_tokens\":10,\"cache_read_input_tokens\":100,\"output_tokens\":4},\"content\":[]}}",
            err("t1"),
            mdelta("m1", "{\"output_tokens\":42}"),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":4},\"content\":[]}}",
            start("m2", "{\"input_tokens\":999,\"output_tokens\":999}"))
        assertTrue(p.toolTurnEnded)
        assertNull(p.usage)
        assertEquals(com.adb.stewart.provider.Usage(115, 42), p.turnUsage())
    }

    @Test
    fun `cut turn without any usage stays null`() {
        val p = ClaudeStreamParser()
        feed(p, start("m1", "null"), tu("t1", "a"), err("t1"), mdelta("m1", "\"bad\""), se("message_stop"))
        assertTrue(p.toolTurnEnded)
        assertNull(p.turnUsage())
        val q = ClaudeStreamParser()
        feed(q, mdelta("m1", "{\"service_tier\":\"x\"}"))
        assertEquals(com.adb.stewart.provider.Usage(null, null), q.turnUsage())
    }

    @Test
    fun `result usage wins over stream usage`() {
        val p = ClaudeStreamParser()
        feed(p, start("m1", "{\"input_tokens\":1,\"output_tokens\":1}"), tu("t1", "a"), err("t1"),
            "{\"type\":\"result\",\"is_error\":false,\"usage\":{\"input_tokens\":7,\"output_tokens\":8},\"total_cost_usd\":0.5}")
        assertEquals(com.adb.stewart.provider.Usage(7, 8, 0.5), p.turnUsage())
        val q = ClaudeStreamParser()
        feed(q, start("m1", "{\"input_tokens\":1,\"output_tokens\":2}"),
            "{\"type\":\"result\",\"is_error\":false}")
        assertEquals(com.adb.stewart.provider.Usage(1, 2), q.turnUsage())
    }

    @Test
    fun `usage of several messages in one turn is summed`() {
        val p = ClaudeStreamParser()
        feed(p,
            start("m1", "{\"input_tokens\":10,\"output_tokens\":1}"), mdelta("m1", "{\"output_tokens\":3}"),
            start("m2", "{\"input_tokens\":20}"), mdelta("m2", "{\"output_tokens\":5}"),
            "{\"type\":\"assistant\",\"message\":{\"content\":[],\"usage\":{\"output_tokens\":2}}}")
        assertEquals(com.adb.stewart.provider.Usage(30, 10), p.turnUsage())
    }

    @Test
    fun `parallel tool_use blocks with per block rejections all surface`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            tu("t1", "a"), err("t1"),
            se("content_block_stop"),
            tu("t2", "b"), err("t2"),
            se("content_block_stop"),
            se("message_delta", ",\"delta\":{\"stop_reason\":\"tool_use\"}"),
            se("message_stop"),
            se("content_block_delta", ",\"delta\":{\"type\":\"text_delta\",\"text\":\"refusal\"}", "m2"),
            "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\"}")
        assertEquals(listOf("t1", "t2"), evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }.map { it.id })
        assertTrue(evs.none { it is ProviderEvent.TextDelta })
        assertTrue(p.toolTurnEnded && !p.resultSeen)
        assertEquals("tool_calls", p.finishReason)
    }

    @Test
    fun `non error tool_result between parallel calls is violation`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, tu("t1", "a"), err("t1"), tu("t2", "b"),
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t2\"}]}}")
        assertEquals("isolation_violation", (evs.last() as ProviderEvent.Failed).code)
        assertTrue(p.failedEmitted && !p.toolTurnEnded)
    }

    @Test
    fun `cut ends on new message stream events but not same message ones`() {
        var p = ClaudeStreamParser()
        feed(p, tu("t1", "a"), err("t1"), se("content_block_stop"), "{\"type\":\"stream_event\",\"event\":{\"type\":\"ping\"}}", "{\"type\":\"system\"}")
        assertTrue(p.cutPending && !p.toolTurnEnded)
        feed(p, se("content_block_start", ",\"content_block\":{\"type\":\"text\"}", "m2"))
        assertTrue(p.toolTurnEnded)
        p = ClaudeStreamParser()
        feed(p, tu("t1", "a"), err("t1"), "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"m2\"}}}")
        assertTrue(p.toolTurnEnded)
        p = ClaudeStreamParser()
        feed(p, tu("t1", "a"), err("t1"), "{\"type\":\"stream_event\"}")
        assertTrue(!p.toolTurnEnded)
    }

    @Test
    fun `result after rejected tool_use keeps usage and tool_calls`() {
        val p = ClaudeStreamParser()
        feed(p, tu("t1", "a"), err("t1"),
            "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"output_tokens\":3}}")
        assertTrue(p.resultSeen && !p.toolTurnEnded)
        assertEquals("tool_calls", p.finishReason)
        assertEquals(3, p.usage?.completionTokens)
    }

    @Test
    fun `repeated tool_use id is not surfaced twice`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, tu("t1", "a"), tu("t1", "a"), tu(null, "b"), tu(null, "b"))
        val calls = evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(listOf("a", "b", "b"), calls.map { it.name })
        assertEquals(3, p.nativeCalls.size)
    }

    @Test
    fun `tool_use across messages and without message id`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, tu("t1", "a", null), tu(null, "b", null), err("t1"), tu("t3", "c", null),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m9\",\"content\":[]}}")
        val calls = evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(listOf("a", "b", "c"), calls.map { it.name })
        assertEquals(null, calls[1].id)
        assertEquals("{\"k\":\"b\"}", calls[1].arguments)
        assertTrue(p.toolTurnEnded)
    }

    @Test
    fun `thinking deltas suppress the whole assistant thinking block`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            se("content_block_delta", ",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}"),
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hmm\"}]}}")
        assertEquals(listOf<ProviderEvent>(ProviderEvent.ReasoningDelta("hmm")), evs)
        val q = ClaudeStreamParser()
        assertEquals(listOf<ProviderEvent>(ProviderEvent.ReasoningDelta("solo")), feed(q,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"solo\"}]}}"))
    }

    @Test
    fun `shim text call without native tool_use stays text`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"<tool_call>{}</tool_call>\"}]}}",
            "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\"}")
        assertEquals(listOf<ProviderEvent>(ProviderEvent.TextDelta("<tool_call>{}</tool_call>")), evs)
        assertEquals("stop", p.finishReason)
        assertTrue(!p.cutPending && !p.toolTurnEnded)
    }

    @Test
    fun `error tool_result without tool_use is ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":true}]}}").isEmpty())
        assertTrue(!p.toolTurnEnded)
        assertNull(p.finishReason)
    }

    @Test
    fun `non error tool_result wins over pending calls`() {
        val p = ClaudeStreamParser()
        feed(p, "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"x\",\"input\":{}}]}}")
        val v = feed(p,
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":false}]}}").single()
            as ProviderEvent.Failed
        assertEquals("isolation_violation", v.code)
        assertTrue(!p.toolTurnEnded)
    }

    @Test
    fun `result with pending native calls finishes tool_calls`() {
        val p = ClaudeStreamParser()
        feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"x\",\"input\":{}}]}}",
            "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\",\"usage\":{\"output_tokens\":1}}")
        assertEquals("tool_calls", p.finishReason)
        val q = ClaudeStreamParser()
        val qevs = feed(q,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"x\",\"input\":{}}]}}",
            "{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}")
        assertEquals("cli_error", (qevs.last() as ProviderEvent.Failed).code)
        assertTrue(q.resultIsError)
        assertNull(q.finishReason)
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
    fun `assistant tool_use surfaced server tool gated`() {
        var p = ClaudeStreamParser()
        val native = feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"bash\",\"input\":{\"c\":1}}]}}")
            .single() as ProviderEvent.NativeToolCalls
        assertEquals("bash", native.calls.single().name)
        assertEquals("{\"c\":1}", native.calls.single().arguments)
        assertTrue(feed(p,
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"name\":\"\"},{\"type\":\"tool_use\"}]}}").isEmpty())
        assertEquals("{}", (feed(ClaudeStreamParser(),
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"x\"}]}}").single()
            as ProviderEvent.NativeToolCalls).calls.single().arguments)
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
    fun `refused tool fixture surfaces the tool_use and ends the turn`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, *java.io.File("src/test/resources/claude/refused-tool-stream.json").readLines().toTypedArray())
        assertTrue(evs.none { it is ProviderEvent.Failed })
        val calls = evs.filterIsInstance<ProviderEvent.NativeToolCalls>().flatMap { it.calls }
        assertEquals(listOf("bash"), calls.map { it.name })
        assertTrue(p.toolTurnEnded)
        assertEquals("tool_calls", p.finishReason)
    }

    @Test
    fun `result is_error as boolean`() {
        val p = ClaudeStreamParser()
        val evs = feed(p, "{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}")
        assertEquals("cli_error", (evs.single() as ProviderEvent.Failed).code)
    }

    @Test
    fun `lines without a type or with unknown type are ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p, "{}", "{\"type\":\"rate_limit_event\"}", "{\"type\":null}").isEmpty())
        assertTrue(!p.resultSeen)
    }

    @Test
    fun `init without tools or mcp keys is fine and subtype missing ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p, "{\"type\":\"system\",\"subtype\":\"init\"}", "{\"type\":\"system\"}").isEmpty())
        val v = feed(p, "{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[\"Bash\"]}").single() as ProviderEvent.Failed
        assertEquals("isolation_violation", v.code)
        assertTrue(p.failedEmitted)
    }

    @Test
    fun `init with non array tools is not a violation`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p, "{\"type\":\"system\",\"subtype\":\"init\",\"tools\":\"none\",\"mcp_servers\":null}").isEmpty())
        assertTrue(!p.failedEmitted)
    }

    @Test
    fun `server tool use without name is a violation`() {
        var p = ClaudeStreamParser()
        assertEquals("isolation_violation", (feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"server_tool_use\"}}}").single()
            as ProviderEvent.Failed).code)
        p = ClaudeStreamParser()
        assertEquals("isolation_violation", (feed(p,
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"server_tool_use\"}]}}").single()
            as ProviderEvent.Failed).code)
    }

    @Test
    fun `content block start with typeless block or non object block ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{}}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":\"text\"}}",
            "{\"type\":\"stream_event\",\"event\":\"x\"}").isEmpty())
    }

    @Test
    fun `delta without type and non object delta ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"x\"}}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":\"x\"}}",
            "{\"type\":\"stream_event\",\"event\":{}}").isEmpty())
        assertTrue(p.deltaMessageIds.isEmpty())
    }

    @Test
    fun `text and thinking deltas emit and text delta records no id when absent`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"t\"}}}")
        assertEquals(listOf(ProviderEvent.TextDelta("a"), ProviderEvent.ReasoningDelta("t")), evs)
        assertTrue(p.deltaMessageIds.isEmpty())
    }

    @Test
    fun `message delta with non object delta or no stop reason keeps stop reason null`() {
        val p = ClaudeStreamParser()
        feed(p,
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":\"x\"}}",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{}}}")
        assertNull(p.stopReason)
        feed(p, "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}}")
        assertEquals("end_turn", p.stopReason)
    }

    @Test
    fun `assistant with non object message or non array content ignored`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"assistant\",\"message\":\"x\"}",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"a\",\"content\":\"text\"}}",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"text\":\"no type\"},\"str\"]}}").isEmpty())
    }

    @Test
    fun `assistant message without id is emitted and text block without text skipped`() {
        val p = ClaudeStreamParser()
        val evs = feed(p,
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\"},{\"type\":\"thinking\"},{\"type\":\"text\",\"text\":\"ok\"}]}}")
        assertEquals(listOf(ProviderEvent.TextDelta("ok")), evs)
    }

    @Test
    fun `user event variants`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p,
            "{\"type\":\"user\"}",
            "{\"type\":\"user\",\"message\":{\"content\":\"plain\"}}",
            "{\"type\":\"user\",\"message\":{\"content\":[\"s\",{\"type\":\"text\"},{\"type\":\"tool_result\",\"is_error\":true}]}}").isEmpty())
        val v = feed(p, "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\"}]}}").single() as ProviderEvent.Failed
        assertEquals("CLI executed a tool", v.message)
    }

    @Test
    fun `result with total cost and without usage object`() {
        var p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"is_error\":false,\"usage\":{\"input_tokens\":1,\"output_tokens\":2},\"total_cost_usd\":0.5}")
        assertEquals(0.5, p.usage?.costUsd ?: -1.0, 0.0)
        p = ClaudeStreamParser()
        feed(p, "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"stop_sequence\"}")
        assertNull(p.usage)
        assertEquals("stop", p.finishReason)
    }

    @Test
    fun `result with non boolean is_error is treated as success`() {
        val p = ClaudeStreamParser()
        assertTrue(feed(p, "{\"type\":\"result\",\"is_error\":\"yes\",\"result\":\"x\"}").isEmpty())
        assertTrue(p.resultSeen && !p.resultIsError && !p.resultFailed)
    }

    @Test
    fun `classify stderr and auth variants`() {
        val p = ClaudeStreamParser()
        assertEquals("auth", p.classifyStderr("HTTP 401 from upstream"))
        assertEquals("auth", p.classifyStderr("Please run claude login"))
        assertEquals("rate_limited", p.classifyStderr("got 429"))
        assertEquals("cli_error", p.classifyStderr("boom"))
        assertNull(p.mapStopReason(null))
        assertEquals("tool_use", p.mapStopReason("tool_use"))
    }
}

package com.adb.stewart

import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.ollama.OllamaNdjson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OllamaNdjsonTest {

    @Test
    fun `content delta parsed`() {
        val event = OllamaNdjson.parseLine("""{"model":"m","message":{"role":"assistant","content":"hello"},"done":false}""")
        assertEquals(ProviderEvent.TextDelta("hello"), event)
    }

    @Test
    fun `empty content skipped`() {
        val event = OllamaNdjson.parseLine("""{"model":"m","message":{"role":"assistant","content":""},"done":false}""")
        assertNull(event)
    }

    @Test
    fun `done with usage and reason`() {
        val event = OllamaNdjson.parseLine(
            """{"model":"m","message":{"role":"assistant","content":""},"done":true,""" +
                """"done_reason":"stop","prompt_eval_count":10,"eval_count":5}"""
        )
        assertTrue(event is ProviderEvent.Completed)
        event as ProviderEvent.Completed
        assertEquals("stop", event.finishReason)
        assertEquals(10, event.usage?.promptTokens)
        assertEquals(5, event.usage?.completionTokens)
    }

    @Test
    fun `error line becomes failed`() {
        val event = OllamaNdjson.parseLine("""{"error":"model 'x' not found"}""")
        assertEquals(ProviderEvent.Failed("model 'x' not found"), event)
    }

    @Test
    fun `unknown fields ignored`() {
        val event = OllamaNdjson.parseLine("""{"model":"m","created_at":"t","extra":{"a":1},"message":{"role":"assistant","content":"hi"},"done":false}""")
        assertEquals(ProviderEvent.TextDelta("hi"), event)
    }

    @Test
    fun `done without reason or usage`() {
        val event = OllamaNdjson.parseLine("""{"done":true}""")
        assertTrue(event is ProviderEvent.Completed)
        event as ProviderEvent.Completed
        assertEquals("stop", event.finishReason)
        assertEquals(null, event.usage?.promptTokens)
        assertEquals(null, event.usage?.completionTokens)
    }

    @Test
    fun `missing message yields null`() {
        assertNull(OllamaNdjson.parseLine("""{"done":false}"""))
    }

    @Test
    fun `message without content yields null`() {
        assertNull(OllamaNdjson.parseLine("""{"message":{"role":"assistant"},"done":false}"""))
    }

    @Test
    fun `delta without done flag parsed`() {
        assertEquals(ProviderEvent.TextDelta("z"), OllamaNdjson.parseLine("""{"message":{"content":"z"}}"""))
    }

    @Test
    fun `extractError uses server error field`() {
        assertEquals("nope", OllamaNdjson.extractError("""{"error":"nope"}""", "HTTP 500"))
    }

    @Test
    fun `extractError falls back to body text`() {
        assertEquals("plain failure", OllamaNdjson.extractError("plain failure", "HTTP 500"))
    }

    @Test
    fun `extractError falls back when json has no error`() {
        assertEquals("HTTP 500", OllamaNdjson.extractError("""{"a":1}""", "HTTP 500"))
    }

    @Test
    fun `extractError blank body falls back`() {
        assertEquals("HTTP 500", OllamaNdjson.extractError("", "HTTP 500"))
    }

    @Test
    fun `extractError json error nested`() {
        assertEquals("HTTP 404", OllamaNdjson.extractError("""{"other":"x"}""", "HTTP 404"))
    }

    @Test
    fun `non boolean done yields null or delta`() {
        assertNull(OllamaNdjson.parseLine("""{"done":"yes"}"""))
        assertNull(OllamaNdjson.parseLine("""{"done":null}"""))
    }

    @Test
    fun `non string error content still surfaces`() {
        assertEquals(ProviderEvent.Failed("123"), OllamaNdjson.parseLine("""{"error":123}"""))
    }

    @Test
    fun `extractError non primitive error falls back`() {
        assertEquals("""{"error":{}}""", OllamaNdjson.extractError("""{"error":{}}""", "HTTP 500"))
    }

    @Test
    fun `extractError non object body returns body`() {
        assertEquals("""["a"]""", OllamaNdjson.extractError("""["a"]""", "HTTP 500"))
    }

    @Test
    fun `null message becomes failed`() {
        val event = OllamaNdjson.parseLine("""{"message":null,"done":false}""")
        assertTrue(event is ProviderEvent.Failed)
    }

    @Test
    fun `non string content becomes failed`() {
        val event = OllamaNdjson.parseLine("""{"message":{"content":{}},"done":false}""")
        assertTrue(event is ProviderEvent.Failed)
    }

    @Test
    fun `non object message becomes failed`() {
        assertTrue(OllamaNdjson.parseLine("""{"message":[],"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":"x","done":false}""") is ProviderEvent.Failed)
    }

    @Test
    fun `malformed line becomes failed`() {
        val event = OllamaNdjson.parseLine("{not json")
        assertTrue(event is ProviderEvent.Failed)
    }

    @Test
    fun `tool calls line parsed with object arguments and synthesised id`() {
        val event = OllamaNdjson.parseLine(
            """{"message":{"role":"assistant","tool_calls":[""" +
                """{"function":{"name":"read_file","arguments":{"path":"a.txt"}}}]},"done":false}"""
        )
        assertTrue(event is ProviderEvent.NativeToolCalls)
        val calls = (event as ProviderEvent.NativeToolCalls).calls
        assertEquals(1, calls.size)
        assertEquals("call_0", calls[0].id)
        assertEquals("read_file", calls[0].name)
        assertEquals("""{"path":"a.txt"}""", calls[0].arguments)
    }

    @Test
    fun `tool calls line with id and two calls`() {
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"tool_calls":[""" +
                """{"id":"c1","function":{"name":"a","arguments":{}}},""" +
                """{"function":{"name":"b","arguments":{"x":1}}}]},"done":false}"""
        )
        assertEquals(1, events.size)
        val calls = (events[0] as ProviderEvent.NativeToolCalls).calls
        assertEquals("c1", calls[0].id)
        assertEquals("call_1", calls[1].id)
        assertEquals("b", calls[1].name)
    }

    @Test
    fun `tool calls and done on same line yields both events`() {
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"tool_calls":[{"function":{"name":"a","arguments":{}}}]},""" +
                """"done":true,"done_reason":"stop","prompt_eval_count":4,"eval_count":1}"""
        )
        assertEquals(2, events.size)
        assertTrue(events[0] is ProviderEvent.NativeToolCalls)
        assertTrue(events[1] is ProviderEvent.Completed)
    }

    @Test
    fun `string arguments passed through`() {
        val event = OllamaNdjson.parseLine(
            """{"message":{"tool_calls":[{"function":{"name":"a","arguments":"{\"x\":2}"}}]},"done":false}"""
        )
        assertEquals("{\"x\":2}", (event as ProviderEvent.NativeToolCalls).calls[0].arguments)
    }

    @Test
    fun `malformed tool calls become failed`() {
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":"x"},"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{}]},"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{"function":{"arguments":{}}}]},"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{"function":{"name":"","arguments":{}}}]},"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{"function":{"name":"a","arguments":[1]}}]},"done":false}""") is ProviderEvent.Failed)
    }

    @Test
    fun `null and empty tool calls skipped`() {
        assertNull(OllamaNdjson.parseLine("""{"message":{"tool_calls":[]},"done":false}"""))
        assertEquals(ProviderEvent.TextDelta("hi"),
            OllamaNdjson.parseLine("""{"message":{"tool_calls":null,"content":"hi"},"done":false}"""))
    }

    @Test
    fun `missing arguments defaults to empty object`() {
        val event = OllamaNdjson.parseLine(
            """{"message":{"tool_calls":[{"function":{"name":"list_dir"}}]},"done":false}"""
        )
        assertEquals("{}", (event as ProviderEvent.NativeToolCalls).calls[0].arguments)
    }

    @Test
    fun `malformed calls plus done yields only failed`() {
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"tool_calls":"x"},"done":true,"done_reason":"stop"}""")
        assertEquals(1, events.size)
        assertTrue(events[0] is ProviderEvent.Failed)
    }

    @Test
    fun `duplicate upstream call ids fail closed`() {
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"tool_calls":[""" +
                """{"id":"c1","function":{"name":"a","arguments":{}}},""" +
                """{"id":"c1","function":{"name":"b","arguments":{}}}]},"done":false}"""
        )
        assertEquals(1, events.size)
        val f = events[0] as ProviderEvent.Failed
        assertEquals("invalid_upstream_response", f.code)
    }

    @Test
    fun `tool calls and content plus done emit in order`() {
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"content":"hi","tool_calls":[{"function":{"name":"a","arguments":{}}}]},""" +
                """"done":true,"done_reason":"stop"}"""
        )
        assertEquals(3, events.size)
        assertEquals(ProviderEvent.TextDelta("hi"), events[0])
        assertTrue(events[1] is ProviderEvent.NativeToolCalls)
        assertTrue(events[2] is ProviderEvent.Completed)
    }

    @Test
    fun `malformed calls with content and done yields only failed`() {
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"content":"hi","tool_calls":"x"},"done":true}""")
        assertEquals(1, events.size)
        assertTrue(events[0] is ProviderEvent.Failed)
    }

    @Test
    fun `custom call id prefix used for missing ids`() {
        var n = 0
        val events = OllamaNdjson.parseLineEvents(
            """{"message":{"tool_calls":[{"function":{"name":"a","arguments":{}}},""" +
                """{"id":"sup","function":{"name":"b","arguments":{}}}]},"done":false}"""
        ) { "p${n++}" }
        val calls = (events[0] as ProviderEvent.NativeToolCalls).calls
        assertEquals("p0", calls[0].id)
        assertEquals("sup", calls[1].id)
    }

    @Test
    fun `non string name and bad argument types rejected`() {
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{"function":{"name":5,"arguments":{}}}]},"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{"function":{"name":"a","arguments":3}}]},"done":false}""") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"tool_calls":[{"function":{"name":"a","arguments":true}}]},"done":false}""") is ProviderEvent.Failed)
    }

    @Test
    fun `more edges`() {
        assertEquals(ProviderEvent.TextDelta("5"), OllamaNdjson.parseLine("""{"message":{"content":5},"done":false}"""))
        assertTrue(OllamaNdjson.parseLine("""{"error":{"message":"x"}}""") is ProviderEvent.Failed)
        assertNull(OllamaNdjson.parseLine("""{"done":false,"done_reason":"x"}"""))
        val d = OllamaNdjson.parseLine("""{"done":true,"done_reason":5}""")
        assertTrue(d is ProviderEvent.Completed)
        assertEquals("5", (d as ProviderEvent.Completed).finishReason)
        assertTrue(OllamaNdjson.parseLine("not json") is ProviderEvent.Failed)
        assertTrue(OllamaNdjson.parseLine("""{"message":{"content":"a"},"done":true,"done_reason":"stop"}""") is ProviderEvent.Completed)
        assertEquals("x", OllamaNdjson.extractError("""{"error":"x"}""", "f"))
        assertEquals("f", OllamaNdjson.extractError("{}", "f"))
        assertEquals("body", OllamaNdjson.extractError("body", "f"))
        assertEquals("f", OllamaNdjson.extractError("", "f"))
    }
}

package com.aijb.assistant

import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.ollama.OllamaNdjson
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
        assertEquals(null, event.finishReason)
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
    fun `malformed line becomes failed`() {
        val event = OllamaNdjson.parseLine("{not json")
        assertTrue(event is ProviderEvent.Failed)
    }
}

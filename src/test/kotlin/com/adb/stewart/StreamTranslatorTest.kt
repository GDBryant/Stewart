package com.adb.stewart

import com.adb.stewart.shim.NativeCallCollector
import com.adb.stewart.shim.StreamTranslator
import com.adb.stewart.shim.ToolCallParseException
import kotlin.random.Random
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamTranslatorTest {

    private val schema = mapOf("read_file" to JsonObject(emptyMap()))
    private val json = Json { ignoreUnknownKeys = true }

    private fun j(s: String) = json.parseToJsonElement(s)

    @Test
    fun `holds tag prefix across chunks`() {
        val t = StreamTranslator(schema)
        val out = StringBuilder()
        for (piece in listOf("Hello ", "wor", "ld <to", "ol_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.py\"}}\n</tool_call>")) {
            out.append(t.feed(piece))
        }
        assertEquals("Hello world ", out.toString())
        val r = t.finish("stop")
        assertEquals("", r.clean)
        assertEquals("read_file", r.calls[0].name)
    }

    @Test
    fun `keeps trailing text`() {
        val t = StreamTranslator(schema)
        val out = t.feed("Hi <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call> bye")
        assertEquals("Hi ", out)
        val r = t.finish("stop")
        assertEquals("bye", r.clean)
        assertEquals(1, r.calls.size)
    }

    @Test
    fun `think at start`() {
        val t = StreamTranslator(schema)
        assertEquals("", t.feed("<think>x</think>Hello"))
        val r = t.finish("stop")
        assertEquals("Hello", r.clean)
        assertEquals("x", r.reasoning)
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun `false alarm`() {
        val t = StreamTranslator(schema)
        assertEquals("a ", t.feed("a "))
        assertEquals("", t.feed("<"))
        assertEquals("< b", t.feed(" b"))
        val r = t.finish("stop")
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun `split call tag held`() {
        val t = StreamTranslator(schema)
        val out = StringBuilder()
        for (piece in listOf("Reading ", "it <ca", "ll>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.py\"}}\n</call>")) {
            out.append(t.feed(piece))
        }
        assertEquals("Reading it ", out.toString())
        val r = t.finish("stop")
        assertEquals("read_file", r.calls[0].name)
    }

    @Test
    fun `releases text that only starts like call tag`() {
        val t = StreamTranslator(schema)
        val out = StringBuilder()
        for (piece in listOf("see <ca", "ption> here")) out.append(t.feed(piece))
        assertEquals("see <caption> here", out.toString())
    }

    @Test
    fun `unsuccessful finish returns held text`() {
        for (reason in listOf("length", "content_filter")) {
            val t = StreamTranslator(schema)
            val held = "<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.py\""
            assertEquals("", t.feed(held))
            val r = t.finish(reason)
            assertEquals(held, r.clean)
            assertTrue(r.calls.isEmpty())
        }
    }

    @Test
    fun `chunk boundary invariance`() {
        val fixtures = listOf(
            "plain text, no calls",
            "Answer <tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}\n</tool_call> done",
            "x<think>why</think>y <call>\n{\"name\":\"read_file\",\"arguments\":{}}\n</call>",
            "text `not a call <tool_call>x` more <tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>",
        )
        for (fixture in fixtures) {
            val whole = StreamTranslator(schema)
            var emitted = whole.feed(fixture)
            val wr = whole.finish("stop")
            emitted += wr.clean
            for (size in listOf(1) + List(3) { Random(42).nextInt(1, 7) }) {
                val t = StreamTranslator(schema)
                val sb = StringBuilder()
                var i = 0
                while (i < fixture.length) {
                    val end = minOf(i + size, fixture.length)
                    sb.append(t.feed(fixture.substring(i, end)))
                    i = end
                }
                val r = t.finish("stop")
                sb.append(r.clean)
                assertEquals(fixture, emitted, sb.toString())
                assertEquals(wr.calls.map { it.name to it.arguments }, r.calls.map { it.name to it.arguments })
            }
        }
    }

    @Test
    fun `collector joins fragments and splits glued name`() {
        val glued = "read_file{\"path\": \"a.py\"}<tool_call>read_file{\"path\": \"b.py\"}"
        val c = NativeCallCollector()
        c.feed(JsonArray(listOf(
            buildJsonObject {
                put("index", 0)
                put("id", "x")
                put("type", "function")
                putJsonObject("function") {
                    put("name", glued.take(20))
                    put("arguments", "")
                }
            })))
        c.feed(JsonArray(listOf(
            buildJsonObject {
                put("index", 0)
                putJsonObject("function") {
                    put("name", glued.drop(20))
                    put("arguments", "{}")
                }
            })))
        c.feed(JsonArray(listOf(
            buildJsonObject {
                put("index", 1)
                put("id", "y")
                putJsonObject("function") {
                    put("name", "read_file")
                    put("arguments", "{\"path\": \"c\"}")
                }
            })))
        val out = c.finish(schema)
        assertEquals(listOf("a.py", "b.py", "c"), out.map { it.arguments["path"]?.let { p -> (p as JsonPrimitive).content } })
        assertEquals(listOf("read_file", "read_file", "read_file"), out.map { it.name })
    }

    @Test
    fun `collector rejects bad fragments`() {
        val bad = listOf(
            "[\"x\"]", "[{\"index\":\"a\"}]", "[{\"index\":-1}]", "[{\"index\":0.5}]",
            "[{\"index\":false}]", "[{\"index\":0.0}]", "[{\"type\":\"other\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]",
            "[{\"function\":\"read_file\"}]", "[{\"function\":{\"name\":1}}]", "[{\"function\":{\"arguments\":1}}]",
        )
        for (b in bad) {
            val c = NativeCallCollector()
            val e = assertThrows(ToolCallParseException::class.java) { c.feed(j(b)) }
            assertEquals("TC-NATIVE-INVALID", e.code)
        }
    }

    @Test
    fun `collector accepts sparse fragments`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"index":0,"id":"x"}]"""))
        c.feed(j("""[{"index":0,"function":{"name":"read_"}}]"""))
        c.feed(j("""[{"index":0,"function":{"name":"file","arguments":"{\"path\""}}]"""))
        c.feed(j("""[{"index":0,"function":{"arguments":": \"a\"}"}}]"""))
        val out = c.finish(schema)
        assertEquals(listOf("read_file"), out.map { it.name })
        assertEquals("a", (out[0].arguments["path"] as JsonPrimitive).content)
    }

    @Test
    fun `collector treats null fields as absent`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"index":0,"id":"x","type":"function","function":{"name":"read_","arguments":null}}]"""))
        c.feed(j("""[{"index":0,"id":null,"type":null,"function":{"name":"file","arguments":"{\"path\": \"a\"}"}}]"""))
        c.feed(j("""[{"index":0,"id":"","function":{"name":null,"arguments":null}}]"""))
        val out = c.finish(schema)
        assertEquals(listOf("read_file"), out.map { it.name })
        assertEquals("x", out[0].id)
        assertEquals("a", (out[0].arguments["path"] as JsonPrimitive).content)
    }

    @Test
    fun `collector generates id when id is null or empty`() {
        for (id in listOf("null", "\"\"")) {
            val c = NativeCallCollector()
            c.feed(j("""[{"id":$id,"function":{"name":"read_file","arguments":"{}"}}]"""))
            assertTrue(id, c.finish(schema)[0].id.startsWith("call_"))
        }
    }

    @Test
    fun `collector rejects call whose name is only null`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"index":0,"function":{"name":null,"arguments":"{}"}}]"""))
        val e = assertThrows(ToolCallParseException::class.java) { c.finish(schema) }
        assertEquals("TC-NATIVE-INVALID", e.code)
    }

    @Test
    fun `collector finish resets`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"index":0,"function":{"name":"read_file","arguments":"{}"}}]"""))
        assertEquals(1, c.finish(schema).size)
        assertTrue(c.finish(schema).isEmpty())
    }

    @Test
    fun `collector generates id when missing`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"function":{"name":"read_file","arguments":"{}"}}]"""))
        val out = c.finish(schema)
        assertTrue(out[0].id.startsWith("call_"))
    }

    @Test
    fun `collector rejects non array deltas`() {
        val c = NativeCallCollector()
        val e = assertThrows(ToolCallParseException::class.java) { c.feed(j("\"x\"")) }
        assertEquals("TC-NATIVE-INVALID", e.code)
    }

    @Test
    fun `emitting fence affects finish start state`() {
        val t = StreamTranslator(schema)
        val out = t.feed("a ``` b")
        assertEquals("a ``` b", out)
        t.feed("<tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>")
        val r = t.finish("stop")
        assertTrue(r.calls.isEmpty())
        assertTrue(r.clean.contains("read_file"))
    }

    @Test
    fun `collector feed null is noop and json null fields are absent`() {
        val c = NativeCallCollector()
        c.feed(null)
        assertTrue(c.isEmpty())
        c.feed(j("""[{"index":null,"id":"i1","function":null}]"""))
        c.feed(j("""[{"index":0,"function":{"name":"read_file","arguments":"{}"}}]"""))
        val raw = c.rawCalls()
        assertEquals(1, raw.size)
        assertEquals("i1", raw[0].id)
        assertEquals("read_file", raw[0].name)
        assertEquals("{}", raw[0].arguments)
    }

    @Test
    fun `collector non primitive type is defaulted and id non primitive ignored`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"index":2,"id":{"x":1},"type":{"y":1},"function":{"name":"read_file","arguments":"{}"}}]"""))
        val raw = c.rawCalls().single()
        assertNull(raw.id)
        assertEquals("read_file", raw.name)
    }

    @Test
    fun `collector orders slots by index and rejects numeric type`() {
        val c = NativeCallCollector()
        c.feed(j("""[{"index":3,"function":{"name":"b","arguments":"2"}},{"index":1,"function":{"name":"a","arguments":"1"}}]"""))
        assertEquals(listOf("a", "b"), c.rawCalls().map { it.name })
        assertEquals(listOf("1", "2"), c.rawCalls().map { it.arguments })
        val e = assertThrows(ToolCallParseException::class.java) { c.feed(j("""[{"type":1}]""")) }
        assertEquals("TC-NATIVE-INVALID", e.code)
        val e2 = assertThrows(ToolCallParseException::class.java) { c.feed(j("""[{"index":[0]}]""")) }
        assertEquals("TC-NATIVE-INVALID", e2.code)
    }

    @Test
    fun `finish with length or content filter returns held text only`() {
        for (reason in listOf("length", "content_filter")) {
            val t = StreamTranslator(schema)
            t.feed("hi <tool_call>{\"name\":\"read_file\",\"arguments\":{}}")
            val r = t.finish(reason)
            assertTrue(r.calls.isEmpty())
            assertTrue(r.clean.contains("read_file"))
            assertEquals("", t.held)
        }
    }

    @Test
    fun `empty feed returns empty and held tag keeps holding`() {
        val t = StreamTranslator(schema)
        assertEquals("", t.feed(""))
        assertEquals("a ", t.feed("a <think>"))
        assertEquals("", t.feed("more text"))
        assertEquals("<think>more text", t.held)
    }
}

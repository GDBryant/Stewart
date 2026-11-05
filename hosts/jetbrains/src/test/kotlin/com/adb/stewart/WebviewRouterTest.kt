package com.adb.stewart

import com.adb.stewart.webview.WebviewRouter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class WebviewRouterTest {
    private class Rig(responder: (String, JsonObject?) -> kotlinx.serialization.json.JsonElement? = { _, _ -> JsonObject(emptyMap()) }) {
        val sent = LinkedBlockingQueue<JsonObject>()
        val calls = mutableListOf<Pair<String, JsonObject?>>()
        val opened = LinkedBlockingQueue<File>()
        val configDir = File(System.getProperty("java.io.tmpdir"), "stewart-router-test-${System.nanoTime()}")
        val router = WebviewRouter(
            projectId = { "p1" },
            request = { m, p ->
                calls.add(m to p)
                CompletableFuture.completedFuture(responder(m, p))
            },
            send = { sent.add(it) },
            userConfigDir = { configDir },
            openInEditor = { opened.add(it) },
        )
    }

    private fun JsonObject.type() = this["type"]!!.jsonPrimitive.content

    @Test
    fun `ready performs handshake and replies`() {
        val rig = Rig()
        rig.router.route("""{"type":"ready"}""")
        assertEquals("ready", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        assertEquals("hello", rig.calls[0].first)
        assertEquals(1, rig.calls[0].second!!["protocol"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun `config get shaped reply`() {
        val rig = Rig { m, _ ->
            if (m == "config.get") JsonObject(mapOf("summary" to JsonObject(emptyMap()), "errors" to Json.parseToJsonElement("[]")))
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"config.get"}""")
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        assertEquals("p1", rig.calls[0].second!!["projectId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `channel test shaped result`() {
        val rig = Rig()
        rig.router.route("""{"type":"channel.test","channelId":"c1"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("channel.test.result", m.type())
        assertEquals("c1", m["channelId"]!!.jsonPrimitive.content)
        assertEquals("c1", rig.calls[0].second!!["channelId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `channel probe shaped result`() {
        val rig = Rig()
        rig.router.route("""{"type":"channel.probe","channelId":"c1","model":"m1","force":true}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("channel.probe.result", m.type())
        assertEquals("c1", m["channelId"]!!.jsonPrimitive.content)
        assertEquals("m1", m["model"]!!.jsonPrimitive.content)
        val p = rig.calls[0].second!!
        assertEquals(true, p["force"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `approve and cancel forwarded`() {
        val rig = Rig()
        rig.router.route("""{"type":"chat.approve","approvalId":"a1","grant":"once"}""")
        rig.router.route("""{"type":"chat.cancel","runId":"r1"}""")
        assertEquals("chat.approve", rig.calls[0].first)
        assertEquals("a1", rig.calls[0].second!!["approvalId"]!!.jsonPrimitive.content)
        assertEquals("chat.cancel", rig.calls[1].first)
    }

    @Test
    fun `chat send forwarded with project id`() {
        val rig = Rig()
        rig.router.route("""{"type":"chat.send","text":"hi"}""")
        val (m, p) = rig.calls[0]
        assertEquals("chat.send", m)
        assertEquals("p1", p!!["projectId"]!!.jsonPrimitive.content)
        assertEquals("hi", p["text"]!!.jsonPrimitive.content)
        assertTrue(!p.containsKey("type"))
    }

    @Test
    fun `malformed message yields error`() {
        val rig = Rig()
        rig.router.route("not json")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("error", m.type())
    }

    @Test
    fun `missing type yields error`() {
        val rig = Rig()
        rig.router.route("""{"x":1}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `request failure yields error message`() {
        val rig = Rig { _, _ -> throw IllegalStateException("sidecar gone") }
        rig.router.route("""{"type":"chat.send","text":"hi"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("error", m.type())
        assertEquals("sidecar gone", m["message"]!!.jsonPrimitive.content)
    }

    @Test
    fun `skills open creates user copy and opens editor`() {
        val rig = Rig { m, p ->
            if (m == "config.get") {
                Json.parseToJsonElement("""{"summary":{"skills":[{"id":"s1","body":"BODY","description":"D"}]}}""") as JsonObject
            } else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"skills.open","id":"s1"}""")
        assertTrue(rig.calls.any { it.first == "skills.save" })
        val f = rig.opened.poll(2, TimeUnit.SECONDS)!!
        assertEquals("s1.md", f.name)
    }

    @Test
    fun `skills open existing file skips save`() {
        val rig = Rig()
        val dir = File(rig.configDir, "skills").also { it.mkdirs() }
        File(dir, "s1.md").writeText("x")
        rig.router.route("""{"type":"skills.open","id":"s1"}""")
        assertTrue(rig.calls.none { it.first == "skills.save" })
        assertEquals("s1.md", rig.opened.poll(2, TimeUnit.SECONDS)!!.name)
    }

    @Test
    fun `skills open unknown id errors`() {
        val rig = Rig()
        rig.router.route("""{"type":"skills.open","id":"nope"}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `skills open missing id errors`() {
        val rig = Rig()
        rig.router.route("""{"type":"skills.open"}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `all remaining message types forward with project id`() {
        val rig = Rig()
        for (t in listOf("chat.resume", "chat.revert", "chat.answer", "config.set", "secret.set", "secret.delete", "skills.save", "skills.reset", "roles.reset", "roles.assignAgent")) {
            rig.router.route("""{"type":"$t","x":1}""")
        }
        assertEquals(10, rig.calls.size)
        rig.calls.forEachIndexed { i, (m, p) ->
            assertEquals(p!!["projectId"]!!.jsonPrimitive.content, "p1")
            assertEquals(1, p["x"]!!.jsonPrimitive.content.toInt())
        }
    }

    @Test
    fun `chat send with images and direct`() {
        val rig = Rig()
        rig.router.route("""{"type":"chat.send","text":"hi","images":["d1"],"direct":true}""")
        val p = rig.calls[0].second!!
        assertTrue(p.containsKey("images"))
        assertTrue(p.containsKey("direct"))
    }

    @Test
    fun `probe without force omits flag`() {
        val rig = Rig()
        rig.router.route("""{"type":"channel.probe","channelId":"c","model":"m"}""")
        assertEquals("channel.probe", rig.calls[0].first)
        assertTrue(!rig.calls[0].second!!.containsKey("force"))
    }

    @Test
    fun `non object json errors`() {
        val rig = Rig()
        rig.router.route("[1,2]")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `ready handshake failure yields error`() {
        val rig = Rig { m, _ -> if (m == "hello") throw IllegalStateException("no sidecar") else JsonObject(emptyMap()) }
        rig.router.route("""{"type":"ready"}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `channel test result carries models`() {
        val rig = Rig { m, _ ->
            if (m == "channel.test") kotlinx.serialization.json.Json.parseToJsonElement("""{"ok":true,"models":["a","b"]}""") as JsonObject
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"channel.test","channelId":"c1"}""")
        val r = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertTrue(r["models"].toString().contains("a"))
    }

    @Test
    fun `config get null response still shaped`() {
        val rig = Rig { _, _ -> null }
        rig.router.route("""{"type":"config.get"}""")
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `skills open without description`() {
        val rig = Rig { m, _ ->
            if (m == "config.get") {
                kotlinx.serialization.json.Json.parseToJsonElement("""{"summary":{"skills":[{"id":"s2","body":"B"}]}}""") as JsonObject
            } else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"skills.open","id":"s2"}""")
        assertTrue(rig.calls.any { it.first == "skills.save" })
        val save = rig.calls.find { it.first == "skills.save" }!!.second!!
        assertEquals("", save["description"]!!.jsonPrimitive.content)
    }

    @Test
    fun `channel test missing channel id sends empty`() {
        val rig = Rig()
        rig.router.route("""{"type":"channel.test"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("", m["channelId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `channel probe missing ids sends empty`() {
        val rig = Rig()
        rig.router.route("""{"type":"channel.probe"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("", m["channelId"]!!.jsonPrimitive.content)
        assertEquals("", m["model"]!!.jsonPrimitive.content)
    }

    @Test
    fun `skills open config without summary errors`() {
        val rig = Rig { m, _ -> if (m == "config.get") JsonObject(emptyMap()) else JsonObject(emptyMap()) }
        rig.router.route("""{"type":"skills.open","id":"s"}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `non primitive type errors`() {
        val rig = Rig()
        rig.router.route("""{"type":{"x":1}}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `skills open skill entry without id is skipped`() {
        val rig = Rig { m, _ ->
            if (m == "config.get") {
                kotlinx.serialization.json.Json.parseToJsonElement("""{"summary":{"skills":[{"body":"B"}]}}""") as JsonObject
            } else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"skills.open","id":"s3"}""")
        assertEquals("error", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }
}

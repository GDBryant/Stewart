package com.adb.stewart

import com.adb.stewart.webview.WebviewRouter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class WebviewRouterTest {
    private class Rig(
        pickV1Xml: () -> String? = { null },
        responder: (String, JsonObject?) -> kotlinx.serialization.json.JsonElement? = { _, _ -> JsonObject(emptyMap()) },
    ) {
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
            pickV1Xml = pickV1Xml,
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
    fun `config set refreshes config and sends a config reply`() {
        val rig = Rig { m, _ ->
            if (m == "config.get") Json.parseToJsonElement("""{"summary":{"channels":[]},"errors":[]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"config.set","file":"channels.yaml","yaml":"version: 1"}""")
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        assertEquals("config.set", rig.calls[0].first)
        assertEquals("channels.yaml", rig.calls[0].second!!["file"]!!.jsonPrimitive.content)
        assertEquals("config.get", rig.calls[1].first)
    }

    @Test
    fun `queued messages are processed in order`() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val rig = Rig { m, _ ->
            if (m == "config.set") {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
            }
            JsonObject(emptyMap())
        }
        val t1 = Thread { rig.router.route("""{"type":"config.set","file":"f.yaml","yaml":"v: 1"}""") }
        t1.start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val t2 = Thread { rig.router.route("""{"type":"config.get"}""") }
        t2.start()
        Thread.sleep(200)
        assertEquals(listOf("config.set"), rig.calls.map { it.first })
        release.countDown()
        t1.join(5000)
        t2.join(5000)
        assertEquals(listOf("config.set", "config.get", "config.get"), rig.calls.map { it.first })
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `setup recommend sends a shaped result`() {
        val rig = Rig { m, _ ->
            if (m == "setup.recommend") Json.parseToJsonElement("""{"ok":true,"assignments":[]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"setup.recommend"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("setup.recommend.result", m.type())
        assertTrue(m.containsKey("assignments"))
        assertEquals("setup.recommend", rig.calls[0].first)
        assertEquals("p1", rig.calls[0].second!!["projectId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `setup recommend forwards mode and evaluator`() {
        val rig = Rig { m, _ ->
            if (m == "setup.recommend") Json.parseToJsonElement("""{"ok":true,"assignments":[]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"setup.recommend","mode":"rules","evaluator":{"channel":"c1","model":"m"}}""")
        rig.sent.poll(2, TimeUnit.SECONDS)!!
        val p = rig.calls[0].second!!
        assertEquals("rules", p["mode"]!!.jsonPrimitive.content)
        assertEquals("c1", p["evaluator"]!!.jsonObject["channel"]!!.jsonPrimitive.content)
        assertTrue(!p.containsKey("type"))
    }

    @Test
    fun `setup session channel routes forward the channel and reply with a result type`() {
        val rig = Rig { m, _ ->
            if (m.startsWith("setup.session.")) Json.parseToJsonElement("""{"ok":true}""") else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"setup.session.addChannel","channel":{"id":"aif","type":"openai-compatible"},"apiKey":"k"}""")
        rig.router.route("""{"type":"setup.session.removeChannel","id":"aif"}""")
        val a = rig.sent.poll(2, TimeUnit.SECONDS)!!
        val r = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("setup.session.addChannel.result", a.type())
        assertEquals("setup.session.removeChannel.result", r.type())
        assertEquals(listOf("setup.session.addChannel", "setup.session.removeChannel"), rig.calls.map { it.first })
        val p = rig.calls[0].second!!
        assertEquals("p1", p["projectId"]!!.jsonPrimitive.content)
        assertEquals("aif", p["channel"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("k", p["apiKey"]!!.jsonPrimitive.content)
        assertEquals("aif", rig.calls[1].second!!["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `setup probe routes return shaped snapshots`() {
        val rig = Rig { m, _ ->
            if (m.startsWith("setup.probe.")) {
                Json.parseToJsonElement("""{"status":"running","ranking":false,"items":[],"green":[]}""")
            } else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"setup.probe.start","candidates":[{"channel":"c1","model":"m"}]}""")
        rig.router.route("""{"type":"setup.probe.status"}""")
        rig.router.route("""{"type":"setup.probe.cancel"}""")
        rig.router.route("""{"type":"setup.probe.retry"}""")
        repeat(4) {
            val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
            assertEquals("setup.probe.result", m.type())
            assertEquals("running", m["status"]!!.jsonPrimitive.content)
        }
        assertEquals(
            listOf("setup.probe.start", "setup.probe.status", "setup.probe.cancel", "setup.probe.retry"),
            rig.calls.map { it.first },
        )
        val p = rig.calls[0].second!!
        assertEquals("p1", p["projectId"]!!.jsonPrimitive.content)
        assertEquals("c1", p["candidates"]!!.jsonArray[0].jsonObject["channel"]!!.jsonPrimitive.content)
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
        for (t in listOf("chat.resume", "chat.revert", "chat.answer", "secret.set", "secret.delete", "skills.save", "skills.reset", "roles.reset", "roles.assignAgent")) {
            rig.router.route("""{"type":"$t","x":1}""")
        }
        assertEquals(9, rig.calls.size)
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
    fun `history list shaped reply`() {
        val rig = Rig { m, _ ->
            if (m == "history.list") Json.parseToJsonElement("""{"sessions":[{"sessionId":"s1","title":"t","savedAt":1,"messageCount":2}]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"history.list"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("history.sessions", m.type())
        assertTrue(m.containsKey("sessions"))
        assertEquals("history.list", rig.calls[0].first)
        assertEquals("p1", rig.calls[0].second!!["projectId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `history load shaped reply carries session id`() {
        val rig = Rig { m, _ ->
            if (m == "history.load") Json.parseToJsonElement("""{"messages":[{"role":"user","content":"hi"}]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"history.load","sessionId":"s1"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("history.messages", m.type())
        assertEquals("s1", m["sessionId"]!!.jsonPrimitive.content)
        assertEquals("s1", rig.calls[0].second!!["sessionId"]!!.jsonPrimitive.content)
        assertTrue(m.containsKey("messages"))
    }

    @Test
    fun `history delete refreshes the session list`() {
        val rig = Rig { m, _ ->
            if (m == "history.list") Json.parseToJsonElement("""{"sessions":[]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"history.delete","sessionId":"s1"}""")
        assertEquals("history.delete", rig.calls[0].first)
        assertEquals("s1", rig.calls[0].second!!["sessionId"]!!.jsonPrimitive.content)
        assertEquals("history.list", rig.calls[1].first)
        assertEquals("history.sessions", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `config importV1 apply reply carries applied flag and xml`() {
        val rig = Rig { m, _ ->
            if (m == "config.importV1") Json.parseToJsonElement("""{"files":{"channels.yaml":"v:1"},"warnings":[]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"config.importV1","xml":"<x/>","apply":true}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("v1.draft", m.type())
        assertEquals("true", m["applied"]!!.jsonPrimitive.content)
        assertEquals("<x/>", m["xml"]!!.jsonPrimitive.content)
        assertEquals("<x/>", rig.calls[0].second!!["xml"]!!.jsonPrimitive.content)
    }

    @Test
    fun `v1 import picks xml and replies draft`() {
        val rig = Rig(pickV1Xml = { "<v1/>" }) { _, _ -> Json.parseToJsonElement("""{"files":{},"warnings":[]}""") }
        rig.router.route("""{"type":"v1.import"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("v1.draft", m.type())
        assertEquals("<v1/>", m["xml"]!!.jsonPrimitive.content)
        assertEquals("config.importV1", rig.calls[0].first)
        assertEquals("<v1/>", rig.calls[0].second!!["xml"]!!.jsonPrimitive.content)
    }

    @Test
    fun `v1 import does nothing when the picker is cancelled`() {
        val rig = Rig()
        rig.router.route("""{"type":"v1.import"}""")
        assertTrue(rig.calls.isEmpty())
        assertTrue(rig.sent.isEmpty())
    }

    @Test
    fun `shaped replies tolerate a null core response`() {
        val rig = Rig { _, _ -> null }
        rig.router.route("""{"type":"config.get"}""")
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        rig.router.route("""{"type":"channel.test","channelId":"c"}""")
        assertEquals("channel.test.result", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        rig.router.route("""{"type":"channel.probe","channelId":"c","model":"m"}""")
        assertEquals("channel.probe.result", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        rig.router.route("""{"type":"history.list"}""")
        assertEquals("history.sessions", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        rig.router.route("""{"type":"history.load","sessionId":"s"}""")
        val lm = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("history.messages", lm.type())
        assertEquals("s", lm["sessionId"]!!.jsonPrimitive.content)
        rig.router.route("""{"type":"history.delete","sessionId":"s"}""")
        assertEquals("history.sessions", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        rig.router.route("""{"type":"config.importV1","xml":"<x/>"}""")
        val d = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("v1.draft", d.type())
        assertEquals("false", d["applied"]!!.jsonPrimitive.content)
        rig.router.route("""{"type":"config.set","file":"f.yaml","yaml":"v: 1"}""")
        assertEquals("config", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
        rig.router.route("""{"type":"setup.recommend"}""")
        assertEquals("setup.recommend.result", rig.sent.poll(2, TimeUnit.SECONDS)!!.type())
    }

    @Test
    fun `config importV1 without xml key sends empty xml`() {
        val rig = Rig { m, _ ->
            if (m == "config.importV1") Json.parseToJsonElement("""{"files":{},"warnings":[]}""")
            else JsonObject(emptyMap())
        }
        rig.router.route("""{"type":"config.importV1"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("v1.draft", m.type())
        assertEquals("", m["xml"]!!.jsonPrimitive.content)
    }

    @Test
    fun `request failure without message yields generic error`() {
        val rig = Rig { _, _ -> throw RuntimeException() }
        rig.router.route("""{"type":"config.get"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("error", m.type())
        assertEquals("error", m["message"]!!.jsonPrimitive.content)
    }

    @Test
    fun `config set failure yields error message`() {
        val rig = Rig { m, _ -> if (m == "config.set") throw IllegalStateException("bad yaml") else JsonObject(emptyMap()) }
        rig.router.route("""{"type":"config.set","file":"f.yaml","yaml":"v"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("error", m.type())
        assertEquals("bad yaml", m["message"]!!.jsonPrimitive.content)
    }

    @Test
    fun `request failure prefers the cause message`() {
        val rig = Rig { _, _ -> throw RuntimeException(java.io.IOException("root cause")) }
        rig.router.route("""{"type":"config.get"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("error", m.type())
        assertEquals("root cause", m["message"]!!.jsonPrimitive.content)
    }

    @Test
    fun `history load missing session id sends empty`() {
        val rig = Rig()
        rig.router.route("""{"type":"history.load"}""")
        val m = rig.sent.poll(2, TimeUnit.SECONDS)!!
        assertEquals("history.messages", m.type())
        assertEquals("", m["sessionId"]!!.jsonPrimitive.content)
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

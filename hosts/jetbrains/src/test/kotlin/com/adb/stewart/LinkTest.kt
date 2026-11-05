package com.adb.stewart

import com.adb.stewart.rpc.Link
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.TimeUnit

class LinkTest {
    private fun linkPair(): Pair<Link, Link> {
        val aToBOut = PipedOutputStream()
        val aToBIn = PipedInputStream(aToBOut)
        val bToAOut = PipedOutputStream()
        val bToAIn = PipedInputStream(bToAOut)
        val a = Link(aToBIn, bToAOut)
        val b = Link(bToAIn, aToBOut)
        a.start(); b.start()
        return a to b
    }

    @Test
    fun `request response round trip`() {
        val (a, b) = linkPair()
        b.onRequest { method, params ->
            java.util.concurrent.CompletableFuture.completedFuture(
                JsonObject(mapOf("echo" to JsonPrimitive(method), "got" to (params ?: JsonPrimitive("")))),
            )
        }
        val r = a.request("ping", JsonObject(mapOf("x" to JsonPrimitive(1)))).get(5, TimeUnit.SECONDS)
        assertEquals("ping", r!!.jsonObject["echo"]!!.jsonPrimitive.content)
        a.close(); b.close()
    }

    @Test
    fun `request error propagates`() {
        val (a, b) = linkPair()
        b.onRequest { _, _ ->
            java.util.concurrent.CompletableFuture<kotlinx.serialization.json.JsonElement?>().apply { completeExceptionally(IllegalStateException("boom")) }
        }
        try {
            a.request("fail").get(5, TimeUnit.SECONDS)
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.cause?.message?.contains("boom") == true || e.message?.contains("boom") == true)
        }
        a.close(); b.close()
    }

    @Test
    fun `notification reaches handlers`() {
        val (a, b) = linkPair()
        val seen = java.util.concurrent.LinkedBlockingQueue<String>()
        b.onNotification { m, _ -> seen.add(m) }
        a.notify("event", JsonObject(mapOf("v" to JsonPrimitive(1))))
        assertEquals("event", seen.poll(5, TimeUnit.SECONDS))
        a.close(); b.close()
    }

    @Test
    fun `malformed line emits protocol error`() {
        val (a, b) = linkPair()
        val errs = java.util.concurrent.LinkedBlockingQueue<String>()
        a.onNotification { m, p -> if (m == "protocol.error") errs.add(p.toString()) }
        b.notify("ok")
        // feed b's side raw garbage by writing to a's input directly instead:
        a.close(); b.close()

        val out = ByteArrayOutputStream()
        val input = ByteArrayInputStream("{not json}\n".toByteArray())
        val l = Link(input, out)
        l.start()
        Thread.sleep(300)
        val lines = out.toString().lines().filter { it.isNotBlank() }
        assertTrue(lines.any { it.contains("protocol.error") && it.contains("malformed") })
    }

    @Test
    fun `oversized line is rejected`() {
        val out = ByteArrayOutputStream()
        val big = "x".repeat(200)
        val input = ByteArrayInputStream("{\"method\":\"m\",\"params\":{\"b\":\"$big\"}}\n".toByteArray())
        val l = Link(input, out, maxLineBytes = 64)
        l.start()
        Thread.sleep(300)
        assertTrue(l.closed)
        assertTrue(out.toString().contains("rpc line too large"))
    }

    @Test
    fun `close fails pending requests`() {
        val out = ByteArrayOutputStream()
        val input = ByteArrayInputStream(byteArrayOf())
        val l = Link(input, out)
        val f = l.request("never")
        l.close("done")
        assertTrue(f.isCompletedExceptionally)
        assertTrue(l.closed)
        // request after close also fails fast
        val f2 = l.request("later")
        assertTrue(f2.isCompletedExceptionally)
    }

    @Test
    fun `notification subscriber failure is isolated`() {
        val (a, b) = linkPair()
        val seen = java.util.concurrent.LinkedBlockingQueue<String>()
        b.onNotification { _, _ -> throw RuntimeException("bad subscriber") }
        b.onNotification { m, _ -> seen.add(m) }
        a.notify("evt")
        assertEquals("evt", seen.poll(5, TimeUnit.SECONDS))
        assertFalse(b.closed)
        a.close(); b.close()
    }

    @Test
    fun `request and notify without params`() {
        val (a, b) = linkPair()
        b.onRequest { m, p ->
            assertNull(p)
            java.util.concurrent.CompletableFuture.completedFuture<kotlinx.serialization.json.JsonElement?>(null)
        }
        val seen = java.util.concurrent.LinkedBlockingQueue<String>()
        b.onNotification { m, p -> seen.add("$m:${p == null}") }
        val res = a.request("noparams").get(5, TimeUnit.SECONDS)
        assertTrue(res == null || res is kotlinx.serialization.json.JsonNull)
        a.notify("ping")
        assertEquals("ping:true", seen.poll(5, TimeUnit.SECONDS))
        a.close(); b.close()
    }

    @Test
    fun `response for unknown id is ignored`() {
        val out = ByteArrayOutputStream()
        val input = ByteArrayInputStream("""{"id":99,"result":1}""".plus("\n").toByteArray())
        val l = Link(input, out)
        l.start()
        Thread.sleep(300)
        assertTrue(l.closed) // stdin closed cleanly, no crash
    }

    @Test
    fun `double close is a no op`() {
        val out = ByteArrayOutputStream()
        val l = Link(ByteArrayInputStream(byteArrayOf()), out)
        l.close("one")
        l.close("two")
        assertTrue(l.closed)
    }

    @Test
    fun `blank lines and id-less objects are skipped`() {
        val out = ByteArrayOutputStream()
        val seen = java.util.concurrent.LinkedBlockingQueue<String>()
        val input = ByteArrayInputStream("\n  \n{\"x\":1}\n{\"method\":\"m\"}\n".toByteArray())
        val l = Link(input, out)
        l.onNotification { m, _ -> seen.add(m) }
        l.start()
        assertEquals("m", seen.poll(5, TimeUnit.SECONDS))
        assertTrue(seen.isEmpty())
    }

    @Test
    fun `non numeric id treated as notification`() {
        val out = ByteArrayOutputStream()
        val seen = java.util.concurrent.LinkedBlockingQueue<String>()
        val input = ByteArrayInputStream("""{"id":"abc","method":"weird"}""".plus("\n").toByteArray())
        val l = Link(input, out)
        l.onNotification { m, _ -> seen.add(m) }
        l.start()
        assertEquals("weird", seen.poll(5, TimeUnit.SECONDS))
    }

    @Test
    fun `numeric method name becomes a request`() {
        val out = ByteArrayOutputStream()
        val input = ByteArrayInputStream("""{"id":1,"method":5}""".plus("\n").toByteArray())
        val l = Link(input, out)
        l.start()
        Thread.sleep(300)
        val lines = out.toString().lines().filter { it.isNotBlank() }
        assertTrue(lines.any { it.contains("\"id\":1") && it.contains("error") })
    }

    @Test
    fun `non object json emits protocol error`() {
        val out = ByteArrayOutputStream()
        val input = ByteArrayInputStream("5\n".toByteArray())
        val l = Link(input, out)
        l.start()
        Thread.sleep(300)
        assertTrue(out.toString().contains("protocol.error"))
    }

    @Test
    fun `error response without message fails generically`() {
        val out = ByteArrayOutputStream()
        val req = """{"id":1,"method":"x"}"""
        val resp = """{"id":1,"error":{}}"""
        val input = ByteArrayInputStream("$resp\n".toByteArray())
        val l = Link(input, out)
        val f = l.request("x")
        l.start()
        try {
            f.get(5, TimeUnit.SECONDS)
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.cause?.message == "rpc error" || e.message!!.contains("rpc error"))
        }
    }

    @Test
    fun `write failure closes link`() {
        val dead = object : java.io.OutputStream() {
            override fun write(b: Int) { throw java.io.IOException("dead") }
        }
        val l = Link(ByteArrayInputStream(byteArrayOf()), dead)
        val f = l.request("x")
        assertTrue(l.closed)
        assertTrue(f.isCompletedExceptionally)
    }

    @Test
    fun `read failure closes link`() {
        val dead = object : java.io.InputStream() {
            override fun read() = throw java.io.IOException("boom")
        }
        val l = Link(dead, ByteArrayOutputStream())
        l.start()
        Thread.sleep(300)
        assertTrue(l.closed)
    }

    @Test
    fun `notify after close writes nothing`() {
        val out = ByteArrayOutputStream()
        val l = Link(ByteArrayInputStream(byteArrayOf()), out)
        l.close()
        l.notify("x")
        assertEquals("", out.toString())
    }
}

package com.adb.stewart

import com.adb.stewart.host.ProcessRegistry
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class ProcessRegistryTest {
    private fun rig(): Pair<ProcessRegistry, LinkedBlockingQueue<Pair<String, JsonObject>>> {
        val events = LinkedBlockingQueue<Pair<String, JsonObject>>()
        return ProcessRegistry { m, p -> events.add(m to p) } to events
    }

    @Test
    fun `run streams output and exit`() {
        val (reg, events) = rig()
        reg.run("h1", listOf("/bin/sh", "-c", "echo hello"), null, null)
        val out = StringBuilder()
        var code: Int? = null
        val deadline = System.currentTimeMillis() + 10_000
        while (code == null && System.currentTimeMillis() < deadline) {
            val (m, p) = events.poll(10, TimeUnit.SECONDS) ?: break
            if (m == "proc.output") out.append(p["data"]!!.jsonPrimitive.content)
            if (m == "proc.exit") code = p["code"]!!.jsonPrimitive.content.toInt()
        }
        assertTrue(out.toString().contains("hello"))
        assertEquals(0, code)
    }

    @Test
    fun `child sees EOF on stdin`() {
        val (reg, events) = rig()
        reg.run("h2", listOf("/bin/cat"), null, null)
        var code: Int? = null
        val deadline = System.currentTimeMillis() + 10_000
        while (code == null && System.currentTimeMillis() < deadline) {
            val (m, p) = events.poll(10, TimeUnit.SECONDS) ?: break
            if (m == "proc.exit") code = p["code"]!!.jsonPrimitive.content.toInt()
        }
        assertEquals(0, code)
    }

    @Test
    fun `killTree terminates process`() {
        val (reg, events) = rig()
        reg.run("h3", listOf("/bin/sleep", "30"), null, null)
        assertTrue(reg.running().contains("h3"))
        reg.killTree("h3")
        val deadline = System.currentTimeMillis() + 10_000
        var exited = false
        while (!exited && System.currentTimeMillis() < deadline) {
            val (m) = events.poll(10, TimeUnit.SECONDS) ?: break
            if (m == "proc.exit") exited = true
        }
        assertTrue(exited)
        assertTrue(reg.running().isEmpty())
    }

    @Test
    fun `killTree on unknown handle is a no op`() {
        val (reg) = rig()
        reg.killTree("nope")
    }
}

package com.adb.stewart

import com.adb.stewart.sidecar.SidecarSupervisor
import com.adb.stewart.sidecar.SupervisorState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class SidecarSupervisorTest {
    /** Fake child process: test writes its stdout, reads its stdin, ends it with a code. */
    class FakeProcess : Process() {
        val childStdout = PipedOutputStream()
        private val stdoutIn = PipedInputStream(childStdout)
        val childStdin = PipedInputStream()
        private val stdinOut = PipedOutputStream(childStdin)
        private val exit = LinkedBlockingQueue<Int>()
        @Volatile var destroyed = false

        fun end(code: Int) {
            exit.add(code)
            childStdout.close()
        }

        override fun getOutputStream() = stdinOut
        override fun getInputStream() = stdoutIn
        override fun getErrorStream() = java.io.ByteArrayInputStream(byteArrayOf())
        override fun waitFor() = exit.take()
        override fun waitFor(timeout: Long, unit: TimeUnit) = exit.poll(timeout, unit) != null
        override fun exitValue() = exit.peek() ?: throw IllegalThreadStateException()
        override fun destroy() {
            destroyed = true
            exit.offer(0)
        }
        override fun destroyForcibly(): Process {
            destroy()
            return this
        }
        override fun isAlive() = exit.peek() == null
    }

    private open class Rig(spawn: (Rig) -> Process = { r -> r.newProcess() }) {
        var now = 0L
        val launches = AtomicInteger()
        val procs = ArrayDeque<FakeProcess>()
        val scheduled = ArrayDeque<Pair<Long, () -> Unit>>()
        val supervisor = SidecarSupervisor(
            command = listOf("node", "sidecar.cjs"),
            launcher = { _, _ ->
                launches.incrementAndGet()
                spawn(this)
            },
            clock = { now },
            schedule = { d, t -> scheduled.addLast(d to t) },
        )

        fun newProcess() = FakeProcess().also { procs.addLast(it) }

        fun pumpRestart() {
            val (d, t) = scheduled.removeFirstOrNull() ?: error("no restart scheduled")
            now += d
            t()
        }
    }

    private class FailRig : Rig({ throw IOException("no node") })

    @Test
    fun `starts process and reaches RUNNING`() {
        val rig = Rig()
        rig.supervisor.start()
        assertEquals(SupervisorState.RUNNING, rig.supervisor.state)
        assertNotNull(rig.supervisor.link)
        assertEquals(1, rig.launches.get())
    }

    @Test
    fun `request without sidecar fails fast`() {
        val rig = Rig()
        assertTrue(rig.supervisor.request("hello").isCompletedExceptionally)
    }

    @Test
    fun `launch failure schedules restart with backoff`() {
        val rig = FailRig()
        rig.supervisor.start()
        assertEquals(SupervisorState.STOPPED, rig.supervisor.state)
        assertEquals(1, rig.scheduled.size)
        assertEquals(500L, rig.scheduled.first().first)
        rig.pumpRestart()
        assertEquals(1000L, rig.scheduled.first().first)
    }

    @Test
    fun `crash loop degrades after max starts in window`() {
        val rig = FailRig()
        val sup = rig.supervisor
        repeat(5) { sup.start() }
        sup.start()
        assertEquals(SupervisorState.DEGRADED, sup.state)
        assertNotNull(sup.lastError)
        assertEquals(5, rig.launches.get())
        sup.start() // stays degraded, no further launches
        assertEquals(SupervisorState.DEGRADED, sup.state)
        assertEquals(5, rig.launches.get())
    }

    @Test
    fun `starts outside window do not degrade`() {
        val rig = FailRig()
        val sup = rig.supervisor
        repeat(5) { sup.start() }
        rig.now += 61_000
        sup.start()
        assertEquals(SupervisorState.STOPPED, sup.state) // failed, but counted fresh
        assertEquals(6, rig.launches.get())
    }

    @Test
    fun `restart clears degraded state`() {
        val rig = FailRig()
        val sup = rig.supervisor
        repeat(5) { sup.start() }
        sup.start()
        assertEquals(SupervisorState.DEGRADED, sup.state)
        rig.now += 61_000
        sup.restart()
        assertEquals(SupervisorState.STOPPED, sup.state)
        assertEquals(6, rig.launches.get())
    }

    @Test
    fun `dispose kills process and stops`() {
        val rig = Rig()
        val sup = rig.supervisor
        sup.start()
        val p = rig.procs.first()
        sup.dispose()
        assertEquals(SupervisorState.STOPPED, sup.state)
        assertNull(sup.link)
        assertTrue(p.destroyed)
    }

    @Test
    fun `request reaches live link`() {
        val rig = Rig()
        rig.supervisor.start()
        val f = rig.supervisor.request("ping")
        assertTrue(!f.isCompletedExceptionally)
    }

    @Test
    fun `notify before start is a no op`() {
        val rig = Rig()
        rig.supervisor.notify("x")
        assertNull(rig.supervisor.link)
    }

    @Test
    fun `link ready fires on start`() {
        val rig = Rig()
        var ready = false
        rig.supervisor.onLinkReady = { ready = true }
        rig.supervisor.start()
        assertTrue(ready)
    }

    @Test
    fun `process crash schedules restart and stop does not`() {
        val rig = Rig()
        val sup = rig.supervisor
        val exits = java.util.concurrent.LinkedBlockingQueue<Int>()
        sup.onExit = { exits.add(it) }
        sup.start()
        rig.procs.first().end(1)
        // waiter thread + scheduled task run async
        val deadline = System.currentTimeMillis() + 5_000
        while (rig.scheduled.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(1, exits.poll(2, TimeUnit.SECONDS)!!.toInt())
        assertEquals(1, rig.scheduled.size)
        assertTrue(rig.scheduled.first().first >= 500L)
    }

    @Test
    fun `clean exit does not schedule restart`() {
        val rig = Rig()
        val sup = rig.supervisor
        sup.start()
        rig.procs.first().end(0)
        val deadline = System.currentTimeMillis() + 2_000
        while (sup.state != SupervisorState.STOPPED && System.currentTimeMillis() < deadline) Thread.sleep(20)
        Thread.sleep(100)
        assertTrue(rig.scheduled.isEmpty())
    }

    @Test
    fun `start while running is a no op`() {
        val rig = Rig()
        rig.supervisor.start()
        rig.supervisor.start()
        assertEquals(1, rig.launches.get())
    }

    @Test
    fun `long lived process crash resets backoff`() {
        val rig = Rig()
        val sup = rig.supervisor
        sup.start()
        rig.procs.first().end(1)
        waitFor { rig.scheduled.isNotEmpty() }
        rig.pumpRestart() // attempt=1; next crash would wait 1000ms without reset
        rig.now += 11_000 // second process lives long enough to reset backoff
        rig.procs.last().end(1)
        waitFor { rig.scheduled.isNotEmpty() }
        assertEquals(500L, rig.scheduled.first().first)
    }

    @Test
    fun `restart while running keeps running`() {
        val rig = Rig()
        rig.supervisor.start()
        rig.supervisor.restart()
        assertEquals(SupervisorState.RUNNING, rig.supervisor.state)
        assertEquals(1, rig.launches.get())
    }

    @Test
    fun `exit after dispose schedules nothing`() {
        val rig = Rig()
        val sup = rig.supervisor
        sup.start()
        val p = rig.procs.first()
        sup.dispose()
        p.end(1)
        Thread.sleep(200)
        assertTrue(rig.scheduled.isEmpty())
    }

    @Test
    fun `start after dispose is a no op`() {
        val rig = Rig()
        rig.supervisor.dispose()
        rig.supervisor.start()
        assertEquals(0, rig.launches.get())
        assertEquals(SupervisorState.STOPPED, rig.supervisor.state)
    }

    private fun waitFor(f: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!f() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertTrue(f())
    }

    @Test
    fun `dispose twice is a no op`() {
        val rig = Rig()
        rig.supervisor.start()
        rig.supervisor.dispose()
        rig.supervisor.dispose()
        assertEquals(SupervisorState.STOPPED, rig.supervisor.state)
    }

    @Test
    fun `notify delegates to live link`() {
        val rig = Rig()
        rig.supervisor.start()
        rig.supervisor.notify("config.dir", kotlinx.serialization.json.buildJsonObject {
            put("dir", kotlinx.serialization.json.JsonPrimitive("/tmp/x"))
        })
        // fake process stdin should carry the line
        val line = rig.procs.first().childStdin.bufferedReader().readLine()
        assertTrue(line.contains("config.dir"))
    }
}

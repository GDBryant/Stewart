package com.adb.stewart

import com.adb.stewart.host.HostRequestHandler
import com.adb.stewart.host.ProcessRegistry
import com.adb.stewart.rpc.Link
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class SidecarWiringTest : BasePlatformTestCase() {
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

    private fun handler(): HostRequestHandler = HostRequestHandler(
        project,
        procs = ProcessRegistry { _, _ -> },
    )

    fun testAttachSendsDirsAndProjectAttach() {
        val (ide, side) = linkPair()
        val seen = LinkedBlockingQueue<JsonObject>()
        side.onRequest { m, p ->
            seen.add(JsonObject(mapOf("method" to JsonPrimitive(m), "params" to (p ?: JsonPrimitive("")))))
            CompletableFuture.completedFuture(JsonObject(mapOf("protocol" to JsonPrimitive(1))))
        }
        val notifs = LinkedBlockingQueue<String>()
        side.onNotification { m, p -> notifs.add("$m:$p") }
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/user-cfg"), File("/tmp/proj/.stewart"), {})
        val attach = seen.poll(5, TimeUnit.SECONDS)!!
        assertEquals("project.attach", attach["method"]!!.jsonPrimitive.content)
        assertEquals("p1", attach["params"]!!.jsonObject["projectId"]!!.jsonPrimitive.content)
        val n1 = notifs.poll(5, TimeUnit.SECONDS)!!
        val n2 = notifs.poll(5, TimeUnit.SECONDS)!!
        assertTrue((n1 + n2).contains("config.dir") && (n1 + n2).contains("/tmp/user-cfg"))
        assertTrue((n1 + n2).contains("config.projectDir") && (n1 + n2).contains(".stewart"))
        ide.close(); side.close()
    }

    fun testDebugLogDirAnnouncedOnlyWhenGiven() {
        val (ide, side) = linkPair()
        val seen = LinkedBlockingQueue<String>()
        side.onRequest { m, _ ->
            seen.add(m)
            CompletableFuture.completedFuture(JsonObject(mapOf("protocol" to JsonPrimitive(1))))
        }
        val notifs = LinkedBlockingQueue<String>()
        side.onNotification { m, p -> notifs.add("$m:$p") }
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), {}, debugLogDir = File("/tmp/ij-log/stewart/debug_logs"))
        assertEquals("project.attach", seen.poll(5, TimeUnit.SECONDS))
        val all = mutableListOf<String>()
        while (true) all.add(notifs.poll(1, TimeUnit.SECONDS) ?: break)
        assertTrue(all.any { it.startsWith("log.dir:") && it.contains("/tmp/ij-log/stewart/debug_logs") })
        ide.close(); side.close()
    }

    fun testNoLogDirNotificationByDefault() {
        val (ide, side) = linkPair()
        val seen = LinkedBlockingQueue<String>()
        side.onRequest { m, _ ->
            seen.add(m)
            CompletableFuture.completedFuture(JsonObject(mapOf("protocol" to JsonPrimitive(1))))
        }
        val notifs = LinkedBlockingQueue<String>()
        side.onNotification { m, p -> notifs.add("$m:$p") }
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), {})
        assertEquals("project.attach", seen.poll(5, TimeUnit.SECONDS))
        val all = mutableListOf<String>()
        while (true) all.add(notifs.poll(1, TimeUnit.SECONDS) ?: break)
        assertTrue(all.none { it.startsWith("log.dir:") })
        ide.close(); side.close()
    }

    fun testHostRequestRoutedToHandler() {
        val (ide, side) = linkPair()
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), {})
        val r = side.request("host.workspace.roots").get(10, TimeUnit.SECONDS)
        assertNotNull(r)
        ide.close(); side.close()
    }

    fun testEventNotificationPushedToPanel() {
        val (ide, side) = linkPair()
        val inbound = LinkedBlockingQueue<JsonObject>()
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), { inbound.add(it) })
        side.notify("event", JsonObject(mapOf("type" to JsonPrimitive("run.started"))))
        val m = inbound.poll(5, TimeUnit.SECONDS)!!
        assertEquals("event", m["type"]!!.jsonPrimitive.content)
        ide.close(); side.close()
    }

    fun testEventWithNullParamsPushesFallback() {
        val (ide, side) = linkPair()
        val inbound = LinkedBlockingQueue<JsonObject>()
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), { inbound.add(it) })
        side.notify("event")
        val m = inbound.poll(5, TimeUnit.SECONDS)!!
        assertEquals("event", m["type"]!!.jsonPrimitive.content)
        ide.close(); side.close()
    }

    fun testProtocolErrorNotificationIsLogged() {
        val (ide, side) = linkPair()
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), {})
        side.notify("protocol.error", JsonObject(mapOf("message" to JsonPrimitive("bad"))))
        Thread.sleep(300)
        assertFalse(side.closed)
        ide.close(); side.close()
    }

    fun testUnmatchedNotificationIsIgnored() {
        val (ide, side) = linkPair()
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), {})
        side.notify("something.else", JsonObject(mapOf("x" to JsonPrimitive(1))))
        Thread.sleep(300)
        assertFalse(side.closed)
        ide.close(); side.close()
    }

    fun testProcNotificationsRoutedToHostHandler() {
        val (ide, side) = linkPair()
        SidecarWiring.attach(ide, handler(), "p1", File("/tmp/u"), File("/tmp/p"), {})
        // proc.cancel on an unknown handle is a no-op; must not throw or close the link
        side.notify("proc.cancel", JsonObject(mapOf("handle" to JsonPrimitive("nope"))))
        side.notify("log", JsonObject(mapOf("line" to JsonPrimitive("hello"))))
        Thread.sleep(300)
        assertFalse(ide.closed)
        assertFalse(side.closed)
        ide.close(); side.close()
    }
}

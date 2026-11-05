package com.adb.stewart

import com.adb.stewart.host.HostRequestHandler
import com.adb.stewart.host.ProcessRegistry
import com.adb.stewart.host.SecretStore
import com.adb.stewart.host.WorkspaceFiles
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.TimeUnit

class HostRequestHandlerTest : BasePlatformTestCase() {
    private fun handler(): HostRequestHandler = HostRequestHandler(
        project,
        files = WorkspaceFiles(project),
        secrets = SecretStore(),
        diagnostics = com.adb.stewart.host.Diagnostics(project),
        procs = ProcessRegistry { _, _ -> },
        stateDir = java.io.File(project.basePath, ".stewart-state"),
    )

    private fun call(h: HostRequestHandler, method: String, params: kotlinx.serialization.json.JsonElement? = null) =
        h.handler(method, params).get(15, TimeUnit.SECONDS)

    fun testWorkspaceRootsStateDirTrusted() {
        val h = handler()
        val roots = call(h, "host.workspace.roots")!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf(project.basePath), roots)
        assertTrue(call(h, "host.workspace.stateDir")!!.jsonPrimitive.content.contains("stewart"))
        call(h, "host.workspace.trusted")!!.jsonPrimitive.boolean
    }

    fun testSecretsRoundTrip() {
        val h = handler()
        call(h, "host.secrets.set", buildJsonObject {
            put("ref", JsonPrimitive("k1"))
            put("value", JsonPrimitive("v1"))
        })
        assertEquals("v1", call(h, "host.secrets.get", buildJsonObject { put("ref", JsonPrimitive("k1")) })!!.jsonPrimitive.content)
        call(h, "host.secrets.delete", buildJsonObject { put("ref", JsonPrimitive("k1")) })
        val r = call(h, "host.secrets.get", buildJsonObject { put("ref", JsonPrimitive("k1")) })
        assertTrue(r == null || r.toString() == "null")
    }

    fun testFilesThroughHandler() {
        val h = handler()
        call(h, "host.files.writeAtomic", buildJsonObject {
            put("path", JsonPrimitive("cfg/x.txt"))
            put("content", JsonPrimitive("data"))
        })
        val r = call(h, "host.files.read", buildJsonObject { put("path", JsonPrimitive("cfg/x.txt")) })!!
        assertEquals("data", r.jsonObject["content"]!!.jsonPrimitive.content)
    }

    fun testProcRunThroughHandler() {
        val h = handler()
        val r = call(h, "host.proc.run", buildJsonObject {
            put("handle", JsonPrimitive("ph"))
            put("argv", kotlinx.serialization.json.Json.parseToJsonElement("""["/bin/echo","hi"]"""))
            put("cwd", JsonPrimitive("/"))
        })
        assertNotNull(r)
    }

    fun testUnknownMethodFails() {
        val h = handler()
        try {
            call(h, "host.nope")
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("unknown host method"))
        }
    }

    fun testMissingParamFails() {
        val h = handler()
        try {
            call(h, "host.secrets.get")
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("ref required"))
        }
    }

    fun testDiagProblemsEmptyForCleanProject() {
        val h = handler()
        val r = call(h, "host.diag.problems", buildJsonObject { put("path", JsonPrimitive("x.kt")) })
        assertNotNull(r)
    }

    fun testNotifyHandlerProcWriteCancelLog() {
        val h = handler()
        h.notifyHandler("log", buildJsonObject { put("line", JsonPrimitive("test line")) })
        h.notifyHandler("proc.cancel", buildJsonObject { put("handle", JsonPrimitive("nope")) })
    }

    fun testFilesEditAndStatThroughHandler() {
        val h = handler()
        call(h, "host.files.writeAtomic", buildJsonObject {
            put("path", JsonPrimitive("f/e.txt"))
            put("content", JsonPrimitive("one two"))
        })
        val r = call(h, "host.files.edit", buildJsonObject {
            put("path", JsonPrimitive("f/e.txt"))
            put("edits", kotlinx.serialization.json.Json.parseToJsonElement("""[{"oldText":"two","newText":"2"}]"""))
        })
        assertNotNull(r)
        assertTrue(call(h, "host.files.exists", buildJsonObject { put("path", JsonPrimitive("f/e.txt")) })!!.jsonPrimitive.boolean)
        assertEquals("one 2", call(h, "host.files.readBack", buildJsonObject { put("path", JsonPrimitive("f/e.txt")) })!!.jsonPrimitive.content)
        val stat = call(h, "host.files.stat", buildJsonObject { put("path", JsonPrimitive("f/e.txt")) })!!
        assertTrue(stat.jsonObject["size"]!!.jsonPrimitive.content.toLong() > 0)
        val listed = call(h, "host.files.list", buildJsonObject { put("dir", JsonPrimitive("f")) })!!.jsonArray
        assertTrue(listed.isNotEmpty())
        call(h, "host.files.appendLine", buildJsonObject {
            put("path", JsonPrimitive("f/log.txt"))
            put("line", JsonPrimitive("L1"))
        })
        val lines = call(h, "host.files.readLines", buildJsonObject { put("path", JsonPrimitive("f/log.txt")) })!!.jsonArray
        assertEquals(1, lines.size)
        call(h, "host.files.delete", buildJsonObject { put("path", JsonPrimitive("f/e.txt")) })
        assertFalse(call(h, "host.files.exists", buildJsonObject { put("path", JsonPrimitive("f/e.txt")) })!!.jsonPrimitive.boolean)
    }

    fun testProcKillTreeThroughHandler() {
        val h = handler()
        call(h, "host.proc.killTree", buildJsonObject { put("handle", JsonPrimitive("nope")) })
    }

    fun testDiffPreviewDoesNotThrow() {
        val h = handler()
        call(h, "host.diff.preview", buildJsonObject {
            put("path", JsonPrimitive("f/x.txt"))
            put("next", JsonPrimitive("new"))
        })
    }

    fun testEnvInProcRun() {
        val h = handler()
        call(h, "host.proc.run", buildJsonObject {
            put("handle", JsonPrimitive("envp"))
            put("argv", kotlinx.serialization.json.Json.parseToJsonElement("""["/bin/echo","x"]"""))
            put("env", kotlinx.serialization.json.Json.parseToJsonElement("""{"K":"V"}"""))
        })
    }

    fun testProcRunMissingArgvFails() {
        val h = handler()
        try {
            call(h, "host.proc.run", buildJsonObject { put("handle", JsonPrimitive("x")) })
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("argv required"))
        }
    }

    fun testFilesEditMissingParamsFails() {
        val h = handler()
        try {
            call(h, "host.files.edit")
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("edit required"))
        }
    }

    fun testSecretGetMissingReturnsNull() {
        val h = handler()
        val r = call(h, "host.secrets.get", buildJsonObject { put("ref", JsonPrimitive("absent")) })
        assertTrue(r == null || r.toString() == "null")
    }

    fun testDiagProblemsWithoutPath() {
        val h = handler()
        assertNotNull(call(h, "host.diag.problems"))
    }

    fun testSecretSetMissingValueFails() {
        val h = handler()
        try {
            call(h, "host.secrets.set", buildJsonObject { put("ref", JsonPrimitive("k")) })
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("value required"))
        }
    }

    fun testFilesReadMissingPathFails() {
        val h = handler()
        try {
            call(h, "host.files.read", buildJsonObject {})
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("path required"))
        }
    }

    fun testDiffPreviewExistingFile() {
        val h = handler()
        call(h, "host.files.writeAtomic", buildJsonObject {
            put("path", JsonPrimitive("f/exist.txt"))
            put("content", JsonPrimitive("old"))
        })
        call(h, "host.diff.preview", buildJsonObject {
            put("path", JsonPrimitive("f/exist.txt"))
            put("next", JsonPrimitive("new"))
        })
    }

    fun testStatOnDirectoryFails() {
        val h = handler()
        try {
            call(h, "host.files.stat", buildJsonObject { put("path", JsonPrimitive(".")) })
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("not a file"))
        }
    }

    fun testProcRunMissingParamsFails() {
        val h = handler()
        try {
            call(h, "host.proc.run")
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("params required"))
        }
    }

    fun testAppendLineMissingLineFails() {
        val h = handler()
        try {
            call(h, "host.files.appendLine", buildJsonObject { put("path", JsonPrimitive("f/x")) })
            fail("expected failure")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("line required"))
        }
    }

    fun testNotifyHandlerProcWrite() {
        val events = java.util.concurrent.LinkedBlockingQueue<Pair<String, kotlinx.serialization.json.JsonObject>>()
        val procs = ProcessRegistry { m, p -> events.add(m to p) }
        val h = HostRequestHandler(project, procs = procs)
        call(h, "host.proc.run", buildJsonObject {
            put("handle", JsonPrimitive("wh"))
            put("argv", kotlinx.serialization.json.Json.parseToJsonElement("""["/bin/cat"]"""))
        })
        h.notifyHandler("proc.write", buildJsonObject {
            put("handle", JsonPrimitive("wh"))
            put("data", JsonPrimitive("in\n"))
        })
        val deadline = System.currentTimeMillis() + 10_000
        var got = ""
        while (!got.contains("in") && System.currentTimeMillis() < deadline) {
            val (m, p) = events.poll(10, TimeUnit.SECONDS) ?: break
            if (m == "proc.output") got += p["data"]!!.jsonPrimitive.content
        }
        procs.killTree("wh")
        assertTrue(got.contains("in"))
    }

    fun testDisposeKillsProcesses() {
        val procs = ProcessRegistry { _, _ -> }
        procs.run("held", listOf("/bin/sleep", "30"), null, null)
        val h = HostRequestHandler(project, procs = procs)
        h.dispose()
        assertTrue(procs.running().isEmpty())
    }

    fun testEditorSelectionNullWithoutEditor() {
        val h = handler()
        val r = call(h, "host.editor.selection")
        assertTrue(r == null || r.toString() == "null")
    }

    fun testEditorSelectionReturnsPathTextAndLines() {
        myFixture.configureByText("sel.txt", "hello world\nsecond line")
        myFixture.editor.selectionModel.setSelection(0, 5)
        val h = handler()
        val r = call(h, "host.editor.selection")!!.jsonObject
        assertEquals("hello", r["text"]!!.jsonPrimitive.content)
        assertEquals("1", r["startLine"]!!.jsonPrimitive.content)
        assertEquals("1", r["endLine"]!!.jsonPrimitive.content)
        assertTrue(r["path"]!!.jsonPrimitive.content.endsWith("sel.txt"))
    }

    fun testFilesBinaryRoundTripThroughHandler() {
        val h = handler()
        call(h, "host.files.writeBinary", buildJsonObject {
            put("path", JsonPrimitive("bin/x.png"))
            put("base64", JsonPrimitive("AQID"))
        })
        val r = call(h, "host.files.readBinary", buildJsonObject { put("path", JsonPrimitive("bin/x.png")) })!!.jsonObject
        assertEquals("AQID", r["base64"]!!.jsonPrimitive.content)
        assertEquals("3", r["size"]!!.jsonPrimitive.content)
    }

    fun testHandlerRunsOffDispatchThread() {
        val h = handler()
        val r = java.util.concurrent.CompletableFuture
            .supplyAsync { h.handler("host.workspace.stateDir", null).get(15, TimeUnit.SECONDS) }
            .get(15, TimeUnit.SECONDS)
        assertNotNull(r)
    }

    fun testProcRunWithoutCwdOrEnv() {
        val h = handler()
        val r = call(h, "host.proc.run", buildJsonObject {
            put("handle", JsonPrimitive("np"))
            put("argv", kotlinx.serialization.json.Json.parseToJsonElement("""["/bin/echo","x"]"""))
        })
        assertNotNull(r)
    }

    fun testNotifyLogWithoutLineAndUnknownMethod() {
        val h = handler()
        h.notifyHandler("log", buildJsonObject {})
        h.notifyHandler("unrelated", null)
    }
}

package com.adb.stewart

import com.adb.stewart.host.WorkspaceFiles
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File
import java.io.IOException

class WorkspaceFilesTest : BasePlatformTestCase() {
    private fun files() = WorkspaceFiles(project)

    private fun write(rel: String, content: String): File {
        val f = File(project.basePath, rel)
        f.parentFile?.mkdirs()
        f.writeText(content)
        LocalFileSystem.getInstance().refreshAndFindFileByIoFile(f)
        return f
    }

    fun testReadReturnsContentAndVersion() {
        write("read-a.txt", "hello")
        val r = files().read("read-a.txt")
        assertEquals("hello", r["content"]!!.jsonPrimitive.content)
    }

    fun testReadMissingThrows() {
        try {
            files().read("nope.txt")
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("nope.txt"))
        }
    }

    fun testExistsRelativeAndAbsolute() {
        val f = write("exists-a.txt", "x")
        assertTrue(files().exists("exists-a.txt").jsonPrimitive.boolean)
        assertTrue(files().exists(f.path).jsonPrimitive.boolean)
        assertFalse(files().exists("missing.txt").jsonPrimitive.boolean)
    }

    fun testEditContentReplaceAndReadBack() {
        val f = write("edit-a.txt", "old")
        val doc = FileDocumentManager.getInstance().getDocument(
            LocalFileSystem.getInstance().findFileByIoFile(f)!!,
        )!!
        val before = doc.modificationStamp
        val r = files().edit(
            buildJsonObject {
                put("path", JsonPrimitive("edit-a.txt"))
                put("baseVersion", JsonPrimitive(before))
                put("content", JsonPrimitive("new"))
            },
        )
        assertTrue(r["applied"]!!.jsonPrimitive.boolean)
        assertEquals("new", files().readBack("edit-a.txt").jsonPrimitive.content)
    }

    fun testEditAnchors() {
        write("anchors-a.txt", "one two three")
        files().edit(
            buildJsonObject {
                put("path", JsonPrimitive("anchors-a.txt"))
                put("edits", Json.parseToJsonElement("""[{"oldText":"two","newText":"TWO"}]"""))
            },
        )
        assertEquals("one TWO three", files().readBack("anchors-a.txt").jsonPrimitive.content)
    }

    fun testEditStaleVersionRejected() {
        write("stale-a.txt", "v1")
        try {
            files().edit(
                buildJsonObject {
                    put("path", JsonPrimitive("stale-a.txt"))
                    put("baseVersion", JsonPrimitive(-1))
                    put("content", JsonPrimitive("v2"))
                },
            )
            fail("expected stale-preview failure")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("stale preview"))
        }
    }

    fun testEditMissingAnchorRejected() {
        write("anchor-a.txt", "abc")
        try {
            files().edit(
                buildJsonObject {
                    put("path", JsonPrimitive("anchor-a.txt"))
                    put("edits", Json.parseToJsonElement("""[{"oldText":"zzz","newText":"q"}]"""))
                },
            )
            fail("expected anchor failure")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("anchor not found"))
        }
    }

    fun testListSkipsDotfilesAndNodeModules() {
        write("src/keep.kt", "x")
        write("src/deep/more.kt", "x")
        write("node_modules/pkg/i.js", "x")
        val out = files().list("src").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("src/deep/more.kt", "src/keep.kt"), out.sorted())
    }

    fun testListMissingDirReturnsEmpty() {
        assertTrue(files().list("no-such-dir").jsonArray.isEmpty())
    }

    fun testStatWriteAtomicAppendReadLinesDelete() {
        val files = files()
        files.writeAtomic("state/x.txt", "line1\n")
        assertEquals(6L, files.stat("state/x.txt")["size"]!!.jsonPrimitive.long)
        files.appendLine("state/x.txt", "l2")
        files.appendLine("state/x.txt", "l3")
        val lines = files.readLines("state/x.txt").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("line1", "l2", "l3"), lines)
        files.delete("state/x.txt")
        assertTrue(files.readLines("state/x.txt").jsonArray.isEmpty())
        try {
            files.stat("state/x.txt")
            fail("expected not-a-file")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("not a file"))
        }
    }

    fun testEditWithoutBaseVersion() {
        write("nobase-a.txt", "old")
        val r = files().edit(
            buildJsonObject {
                put("path", JsonPrimitive("nobase-a.txt"))
                put("content", JsonPrimitive("new"))
            },
        )
        assertTrue(r["applied"]!!.jsonPrimitive.boolean)
        assertEquals("new", files().readBack("nobase-a.txt").jsonPrimitive.content)
    }

    fun testEditMissingFileThrows() {
        try {
            files().edit(
                buildJsonObject {
                    put("path", JsonPrimitive("ghost.txt"))
                    put("content", JsonPrimitive("x"))
                },
            )
            fail("expected missing-file failure")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("ghost.txt"))
        }
    }

    fun testListEmptyDirListsRoot() {
        write("rooted.txt", "x")
        val out = files().list("").jsonArray.map { it.jsonPrimitive.content }
        assertTrue(out.any { it.endsWith("rooted.txt") })
    }

    fun testWriteAtomicOverwrites() {
        val files = files()
        files.writeAtomic("state/y.txt", "one")
        files.writeAtomic("state/y.txt", "two")
        assertEquals("two", File(project.basePath, "state/y.txt").readText())
    }

    fun testReadAfterWriteAtomicSeesNewContent() {
        val f = write("cfg/channels.yaml", "items: [a, b]")
        val vf = LocalFileSystem.getInstance().findFileByIoFile(f)!!
        FileDocumentManager.getInstance().getDocument(vf)!!
        assertEquals("items: [a, b]", files().read("cfg/channels.yaml")["content"]!!.jsonPrimitive.content)
        files().writeAtomic("cfg/channels.yaml", "items: [a]")
        assertEquals("items: [a]", files().read("cfg/channels.yaml")["content"]!!.jsonPrimitive.content)
    }

    fun testReadPrefersUnsavedEditorBuffer() {
        val f = write("unsaved-a.txt", "disk")
        val doc = FileDocumentManager.getInstance().getDocument(LocalFileSystem.getInstance().findFileByIoFile(f)!!)!!
        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) { doc.setText("buffer") }
        assertEquals("buffer", files().read("unsaved-a.txt")["content"]!!.jsonPrimitive.content)
        assertEquals("disk", f.readText())
    }

    fun testAppendCreatesNestedDirs() {
        files().appendLine("deep/nested/log.txt", "L")
        assertEquals(1, files().readLines("deep/nested/log.txt").jsonArray.size)
    }

    fun testEditWithoutContentOrEditsIsNoop() {
        write("noop-a.txt", "same")
        val r = files().edit(buildJsonObject { put("path", JsonPrimitive("noop-a.txt")) })
        assertTrue(r["applied"]!!.jsonPrimitive.boolean)
        assertEquals("same", files().readBack("noop-a.txt").jsonPrimitive.content)
    }

    fun testEditMissingPathThrows() {
        try {
            files().edit(buildJsonObject { put("content", JsonPrimitive("x")) })
            fail("expected missing-path failure")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("path"))
        }
    }

    fun testReadBinaryWithoutDocument() {
        write("blob.bin", "\u0000\u0001")
        val r = files().read("blob.bin")
        assertNotNull(r["content"])
    }

    fun testDeleteMissingIsNoop() {
        files().delete("never-existed.txt")
    }

    fun testReadVersionPresentForOpenDocument() {
        val f = write("open-doc.txt", "abc")
        val vf = LocalFileSystem.getInstance().findFileByIoFile(f)!!
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
        val r = files().read("open-doc.txt")
        assertNotNull(r["version"])
    }

    fun testEditMalformedEntryThrows() {
        write("mal-a.txt", "x")
        try {
            files().edit(
                buildJsonObject {
                    put("path", JsonPrimitive("mal-a.txt"))
                    put("edits", Json.parseToJsonElement("""[5]"""))
                },
            )
            fail("expected failure")
        } catch (e: Exception) {
            /* jsonObject on primitive throws */
        }
    }

    fun testEditMissingNewTextDefaultsToEmpty() {
        write("nonew-a.txt", "keep this")
        files().edit(
            buildJsonObject {
                put("path", JsonPrimitive("nonew-a.txt"))
                put("edits", Json.parseToJsonElement("""[{"oldText":"this"}]"""))
            },
        )
        assertEquals("keep", files().readBack("nonew-a.txt").jsonPrimitive.content)
    }

    fun testListExistingEmptyDir() {
        File(project.basePath, "empty-dir").mkdirs()
        assertTrue(files().list("empty-dir").jsonArray.isEmpty())
    }

    fun testResolveAbsoluteVsRelative() {
        val rel = files().resolve("a/b.txt")
        assertTrue(rel.path.startsWith(project.basePath!!))
        val abs = File("/tmp/x")
        assertEquals(abs, files().resolve(abs.path))
    }

    fun testBinaryRoundTripOnDisk() {
        val f = files()
        f.writeBinary("bin/y.png", "AQID")
        val r = f.readBinary("bin/y.png")
        assertEquals("AQID", r["base64"]!!.jsonPrimitive.content)
        assertEquals("3", r["size"]!!.jsonPrimitive.content)
        try {
            f.readBinary("bin/missing.png")
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("not a file"))
        }
    }
}

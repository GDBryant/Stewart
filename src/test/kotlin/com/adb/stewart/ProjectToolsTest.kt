package com.adb.stewart

import com.adb.stewart.tools.EditFile
import com.adb.stewart.tools.FindFiles
import com.adb.stewart.tools.ProjectPaths
import com.adb.stewart.tools.ProjectTools
import com.adb.stewart.tools.ReadFile
import com.adb.stewart.tools.RunTerminal
import com.adb.stewart.tools.Search
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.EditTool
import com.adb.stewart.tools.WriteFile
import com.adb.stewart.provider.ToolSpec
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class ProjectToolsTest : BasePlatformTestCase() {

    private lateinit var paths: ProjectPaths
    private lateinit var baseDir: File

    override fun setUp() {
        super.setUp()
        paths = ProjectPaths.forProject(project)
        baseDir = paths.base.toFile()
        baseDir.mkdirs()
        val baseVf = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(baseDir.absolutePath)
        if (baseVf != null) {
            com.intellij.openapi.roots.ModuleRootModificationUtil.updateModel(
                com.intellij.openapi.module.ModuleManager.getInstance(project).modules.first()
            ) { it.addContentEntry(baseVf) }
        }
    }

    private fun args(vararg pairs: Pair<String, Any>): JsonObject = buildJsonObject {
        pairs.forEach { (k, v) ->
            when (v) {
                is String -> put(k, v)
                is Int -> put(k, v)
                is Boolean -> put(k, v)
            }
        }
    }

    private fun write(rel: String, content: String): File {
        val f = File(baseDir, rel)
        f.parentFile?.mkdirs()
        f.writeText(content)
        return f
    }

    private fun contentDir(): File = baseDir

    private fun writeContent(rel: String, content: String): File {
        val f = write(rel, content)
        com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(f.absolutePath)
        return f
    }

    private fun expectError(block: suspend () -> String): String = try {
        runBlocking { block() }
        fail("expected error")
        ""
    } catch (e: IllegalArgumentException) {
        e.message ?: ""
    } catch (e: IllegalStateException) {
        e.message ?: ""
    }

    fun `test read file returns numbered lines`() {
        write("read1.txt", "one\ntwo\nthree")
        val out = runBlocking { ReadFile(project, paths).execute(args("path" to "read1.txt"), null) }
        assertEquals("1: one\n2: two\n3: three", out)
    }

    fun `test read file line range`() {
        write("read2.txt", "one\ntwo\nthree\nfour")
        val out = runBlocking {
            ReadFile(project, paths).execute(
                args("path" to "read2.txt", "start_line" to 2, "end_line" to 3), null)
        }
        assertEquals("2: two\n3: three", out)
    }

    fun `test read file errors`() {
        assertTrue(expectError {
            ReadFile(project, paths).execute(args("path" to "missing.txt"), null)
        }.contains("not found"))
        write("dir/inner.txt", "x")
        assertTrue(expectError {
            ReadFile(project, paths).execute(args("path" to "dir"), null)
        }.isNotEmpty())
        write("readerr.txt", "l1\nl2")
        assertTrue(expectError {
            ReadFile(project, paths).execute(args("path" to "readerr.txt", "start_line" to 9), null)
        }.contains("range"))
        write("bin.bin", "\u0000abc")
        assertTrue(expectError {
            ReadFile(project, paths).execute(args("path" to "bin.bin"), null)
        }.contains("binary"))
    }

    fun `test find files glob`() {
        writeContent("src/x.kt", "x")
        writeContent("src/y.txt", "y")
        writeContent("other/z.kt", "z")
        val out = runBlocking {
            FindFiles(project, paths).execute(
                args("glob" to "**/*.kt", "path" to contentDir().absolutePath), null)
        }
        assertTrue(out.contains("src/x.kt") || out.contains("src\\x.kt") || out.contains("x.kt"))
        assertFalse(out.contains("y.txt"))
    }

    fun `test find files and search exclude stewart dir`() {
        writeContent("src/x.kt", "needle")
        writeContent(".stewart/scratch/r/task-1-1/out.kt", "needle")
        val f = runBlocking { FindFiles(project, paths).execute(args("glob" to "**/*.kt"), null) }
        assertTrue(f.contains("x.kt"))
        assertFalse(f.contains(".stewart"))
        val s = runBlocking { Search(project, paths).execute(args("query" to "needle"), null) }
        assertTrue(s.contains("x.kt"))
        assertFalse(s.contains(".stewart"))
    }

    fun `test find files invalid glob`() {
        assertTrue(expectError {
            FindFiles(project, paths).execute(args("glob" to "["), null)
        }.contains("glob"))
    }

    fun `test search literal and line numbers`() {
        writeContent("s/a.txt", "hello\nworld hello")
        writeContent("s/b.txt", "nope")
        val out = runBlocking {
            Search(project, paths).execute(
                args("query" to "hello", "path" to contentDir().absolutePath), null)
        }
        val lines = out.lines().filter { !it.startsWith("[") }
        assertEquals(2, lines.size)
        assertTrue(lines[0].contains("a.txt:1: hello"))
        assertTrue(lines[1].contains("a.txt:2: world hello"))
    }

    fun `test search regex`() {
        writeContent("r.txt", "abc123\nzzz")
        val out = runBlocking {
            Search(project, paths).execute(
                args("query" to "\\d+", "regex" to true,
                    "path" to contentDir().absolutePath), null)
        }
        assertTrue(out.contains("abc123"))
        assertFalse(out.contains("zzz"))
    }

    fun `test search invalid regex`() {
        assertTrue(expectError {
            Search(project, paths).execute(args("query" to "(", "regex" to true), null)
        }.contains("regex"))
    }

    fun `test search respects max results`() {
        writeContent("m.txt", (1..10).joinToString("\n") { "hit $it" })
        val out = runBlocking {
            Search(project, paths).execute(
                args("query" to "hit", "max_results" to 2,
                    "path" to contentDir().absolutePath), null)
        }
        assertEquals(2, out.lines().filter { !it.startsWith("[") }.size)
        assertTrue(out.contains("more]"))
    }

    fun `test write file creates and previews`() {
        val t = WriteFile(project, paths)
        val prev = runBlocking { t.preview(args("path" to "new/n.txt", "content" to "hello\nworld")) }
        val change = prev as ToolPreview.FileChange
        assertNull(change.before)
        assertEquals("hello\nworld", change.after)
        val out = runBlocking { t.execute(args("path" to "new/n.txt", "content" to "hello\nworld"), prev) }
        assertTrue(out.contains("wrote"))
        assertTrue(File(baseDir, "new/n.txt").readText() == "hello\nworld")
    }

    fun `test write file overwrite previews current`() {
        write("o.txt", "old")
        val t = WriteFile(project, paths)
        val prev = runBlocking { t.preview(args("path" to "o.txt", "content" to "new")) as ToolPreview.FileChange }
        assertEquals("old", prev.before)
        runBlocking { t.execute(args("path" to "o.txt", "content" to "new"), prev) }
        assertEquals("new", File(baseDir, "o.txt").readText())
    }

    fun `test edit file preview and apply`() {
        write("editp.txt", "foo bar foo")
        val t = EditFile(project, paths)
        val prev = runBlocking {
            t.preview(args("path" to "editp.txt", "old_string" to "bar", "new_string" to "BAZ"))
        } as ToolPreview.FileChange
        assertEquals("foo BAZ foo", prev.after)
        runBlocking {
            t.execute(args("path" to "editp.txt", "old_string" to "bar", "new_string" to "BAZ"), prev)
        }
        assertEquals("foo BAZ foo", File(baseDir, "editp.txt").readText())
    }

    fun `test edit file replace all`() {
        write("editr.txt", "foo foo")
        val t = EditFile(project, paths)
        val prev = runBlocking {
            t.preview(args("path" to "editr.txt", "old_string" to "foo",
                "new_string" to "x", "replace_all" to true))
        } as ToolPreview.FileChange
        assertEquals("x x", prev.after)
    }

    fun `test edit file ambiguous match rejected`() {
        write("edita.txt", "foo foo foo")
        val t = EditFile(project, paths)
        val msg = expectError {
            t.preview(args("path" to "edita.txt", "old_string" to "foo", "new_string" to "x")); ""
        }
        assertTrue(msg.contains("3"))
    }

    fun `test edit file not found and empty and missing errors`() {
        val t = EditFile(project, paths)
        assertTrue(expectError {
            t.preview(args("path" to "missing.txt", "old_string" to "a", "new_string" to "b")); ""
        }.contains("not found"))
        write("editn.txt", "abc")
        assertTrue(expectError {
            t.preview(args("path" to "editn.txt", "old_string" to "zzz", "new_string" to "b")); ""
        }.contains("not found"))
        assertTrue(expectError {
            t.preview(args("path" to "editn.txt", "old_string" to "", "new_string" to "b")); ""
        }.contains("empty"))
    }

    fun `test stale preview rejected`() {
        write("stale.txt", "original")
        val t = EditFile(project, paths)
        val prev = runBlocking {
            t.preview(args("path" to "stale.txt", "old_string" to "original", "new_string" to "x"))
        }
        File(baseDir, "stale.txt").writeText("changed meanwhile")
        val msg = expectError {
            t.execute(args("path" to "stale.txt", "old_string" to "original", "new_string" to "x"), prev); ""
        }
        assertTrue(msg.contains("changed since preview"))
        assertEquals("changed meanwhile", File(baseDir, "stale.txt").readText())
    }

    private class FakeDiskEdit(
        project: com.intellij.openapi.project.Project,
        paths: ProjectPaths,
        private val fakeDisk: String?,
    ) : EditTool(project, paths) {
        override val spec = ToolSpec("FakeDiskEdit", "probe", JsonObject(emptyMap()))
        override val requiresApproval = true
        override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String = ""
        suspend fun apply(rawPath: String, change: ToolPreview.FileChange) =
            applyChange(rawPath, JsonObject(emptyMap()), change) { _, _ -> change.after }
        override fun diskText(resolved: java.nio.file.Path, vf: com.intellij.openapi.vfs.VirtualFile): String? = fakeDisk
    }

    fun `test post write read back mismatch fails without reporting success`() {
        val t = FakeDiskEdit(project, paths, "tampered")
        write("rbm.txt", "old")
        val change = ToolPreview.FileChange(
            File(baseDir, "rbm.txt").absolutePath, "old", "new content")
        val msg = expectError { t.apply("rbm.txt", change); "" }
        assertTrue(msg.contains("differs"))
        assertTrue(msg.contains("uncertain"))
        assertEquals("new content", File(baseDir, "rbm.txt").readText())
    }

    fun `test post write missing file fails`() {
        val t = FakeDiskEdit(project, paths, null)
        write("rbn.txt", "old")
        val change = ToolPreview.FileChange(
            File(baseDir, "rbn.txt").absolutePath, "old", "new content")
        val msg = expectError { t.apply("rbn.txt", change); "" }
        assertTrue(msg.contains("missing after write"))
    }

    fun `test write execute cancelled coroutine does not report success`() {
        val t = WriteFile(project, paths)
        val a = args("path" to "cxc.txt", "content" to "x")
        val prev = runBlocking { t.preview(a) }
        val job = kotlinx.coroutines.Job()
        try {
            runBlocking(job) {
                job.cancel()
                t.execute(a, prev)
            }
            fail("expected cancellation")
        } catch (e: CancellationException) {
        }
    }

    fun `test path outside project rejected`() {
        val t = ReadFile(project, paths)
        assertTrue(expectError {
            t.execute(args("path" to "../outside.txt"), null)
        }.contains("outside project"))
    }

    fun `test run terminal echoes`() {
        val t = RunTerminal(project, paths)
        val prev = runBlocking { t.preview(args("command" to "echo hello")) } as ToolPreview.Command
        assertEquals("echo hello", prev.command)
        val out = runBlocking { t.execute(args("command" to "echo hello"), prev) }
        assertTrue(out.startsWith("exit code: 0"))
        assertTrue(out.contains("hello"))
    }

    fun `test run terminal nonzero exit`() {
        val t = RunTerminal(project, paths)
        val out = runBlocking {
            t.execute(args("command" to "exit 3"), t.preview(args("command" to "exit 3")))
        }
        assertTrue(out.startsWith("exit code: 3"))
    }

    fun `test run terminal cwd outside rejected`() {
        val t = RunTerminal(project, paths)
        assertTrue(expectError {
            t.preview(args("command" to "ls", "cwd" to "/")); ""
        }.isNotEmpty())
    }

    fun `test run terminal output capped`() {
        val t = RunTerminal(project, paths)
        val out = runBlocking {
            withTimeout(30_000) {
                t.execute(args("command" to "seq 1 100000"), t.preview(args("command" to "seq 1 100000")))
            }
        }
        assertTrue(out.length <= 200_100)
        assertTrue(out.startsWith("exit code: 0"))
    }

    fun `test run terminal cancellation kills process`() {
        val t = RunTerminal(project, paths)
        val pidFile = File(baseDir, "pid.txt")
        val job = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.Dispatchers.Default).async {
            t.execute(args("command" to "echo $$ > pid.txt; sleep 300"),
                t.preview(args("command" to "echo $$ > pid.txt; sleep 300")))
        }
        runBlocking {
            delay(500)
            job.cancel()
        }
        try {
            runBlocking { withTimeout(10_000) { job.await() } }
            fail("expected cancellation")
        } catch (e: CancellationException) {
        } catch (e: Exception) {
            fail("unexpected $e")
        }
        Thread.sleep(500)
        if (pidFile.exists()) {
            val pid = pidFile.readText().trim().toLongOrNull()
            if (pid != null) {
                assertFalse(ProcessHandle.of(pid).map { it.isAlive }.orElse(false))
            }
        }
    }

    fun `test symlink swap inside to outside rejected on apply`() {
        val outside = java.nio.file.Files.createTempDirectory("stewart-out-").toRealPath()
        java.nio.file.Files.writeString(outside.resolve("sec.txt"), "SECRET")
        val link = java.nio.file.Paths.get(baseDir.absolutePath, "link.txt")
        try {
            java.nio.file.Files.createSymbolicLink(link, baseDir.toPath().resolve("in.txt"))
        } catch (e: Exception) { return }
        write("in.txt", "orig")
        val t = WriteFile(project, paths)
        val prev = runBlocking { t.preview(args("path" to "link.txt", "content" to "X")) }
        java.nio.file.Files.delete(link)
        java.nio.file.Files.createSymbolicLink(link, outside.resolve("sec.txt"))
        val msg = expectError { t.execute(args("path" to "link.txt", "content" to "X"), prev); "" }
        assertTrue(msg.isNotEmpty())
        assertEquals("SECRET", outside.resolve("sec.txt").toFile().readText())
    }

    fun `test search excludes symlinked outside file`() {
        val outside = java.nio.file.Files.createTempDirectory("stewart-out-").toRealPath()
        java.nio.file.Files.writeString(outside.resolve("esc.txt"), "needle secret")
        writeContent("in/a.txt", "needle here")
        try {
            java.nio.file.Files.createSymbolicLink(
                java.nio.file.Paths.get(contentDir().absolutePath, "in", "esc.txt"),
                outside.resolve("esc.txt"))
        } catch (e: Exception) { return }
        val out = runBlocking {
            Search(project, paths).execute(
                args("query" to "needle", "path" to contentDir().absolutePath), null)
        }
        assertTrue(out.contains("needle here"))
        assertFalse(out.contains("SECRET") || out.contains("esc.txt"))
    }

    fun `test run terminal execute requires preview`() {
        val t = RunTerminal(project, paths)
        val msg = expectError { t.execute(args("command" to "echo hi"), null); "" }
        assertTrue(msg.contains("missing preview"))
    }

    fun `test run terminal preview mismatch rejected`() {
        val t = RunTerminal(project, paths)
        val prev = runBlocking { t.preview(args("command" to "echo a")) }
        val msg = expectError { t.execute(args("command" to "echo b"), prev); "" }
        assertTrue(msg.contains("changed since approval"))
    }

    fun `test write file args changed after preview rejected`() {
        write("w.txt", "orig")
        val t = WriteFile(project, paths)
        val prev = runBlocking { t.preview(args("path" to "w.txt", "content" to "A")) }
        val msg = expectError { t.execute(args("path" to "w.txt", "content" to "B"), prev); "" }
        assertTrue(msg.contains("does not match") || msg.contains("changed since preview"))
        assertEquals("orig", File(baseDir, "w.txt").readText())
    }

    fun `test read file binary rejected`() {
        val f = write("bin.dat", "x")
        f.writeBytes(byteArrayOf(0, 1, 2, 3, 4))
        val msg = expectError { ReadFile(project, paths).execute(args("path" to "bin.dat"), null); "" }
        assertTrue(msg.isNotEmpty())
    }

    fun `test read file not found rejected`() {
        val msg = expectError { ReadFile(project, paths).execute(args("path" to "gone.txt"), null); "" }
        assertTrue(msg.isNotEmpty())
    }

    fun `test read file returns unsaved document text`() {
        val f = write("uns.txt", "on disk")
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(f.absolutePath)!!
        val doc = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
            .getDocument(vf)!!
        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(
            project, null, null, Runnable { doc.setText("unsaved edits") })
        val out = runBlocking { ReadFile(project, paths).execute(args("path" to "uns.txt"), null) }
        assertEquals("1: unsaved edits", out)
    }

    fun `test write file preview sees unsaved document`() {
        val f = write("unsw.txt", "on disk")
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(f.absolutePath)!!
        val doc = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
            .getDocument(vf)!!
        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(
            project, null, null, Runnable { doc.setText("unsaved edits") })
        val t = WriteFile(project, paths)
        val prev = runBlocking { t.preview(args("path" to "unsw.txt", "content" to "new")) }
        prev as com.adb.stewart.tools.ToolPreview.FileChange
        assertEquals("unsaved edits", prev.before)
        runBlocking { t.execute(args("path" to "unsw.txt", "content" to "new"), prev) }
        assertEquals("new", File(baseDir, "unsw.txt").readText())
    }

    fun `test search skips oversized file`() {
        val f = write("big.txt", "x")
        f.writeBytes(ByteArray(1_100_000) { 'a'.code.toByte() })
        val out = runBlocking {
            Search(project, paths).execute(
                args("query" to "aaa", "path" to contentDir().absolutePath), null)
        }
        assertFalse(out.contains("big.txt"))
    }

    fun `test registry enabled and disabled`() {
        assertTrue(ProjectTools.registry(project, true).specs.isNotEmpty())
        assertTrue(ProjectTools.registry(project, false).specs.isEmpty())
    }

    fun `test tool specs closed and snake case`() {
        val reg = ProjectTools.registry(project, true)
        val names = reg.specs.map { it.name }
        assertTrue("ReadFile" in names && "EditFile" in names && "RunTerminal" in names &&
            "FindFiles" in names && "Search" in names && "WriteFile" in names)
        reg.specs.forEach { spec ->
            assertEquals(JsonPrimitive(false), spec.parameters["additionalProperties"])
        }
    }

    fun `test run terminal cancellation kills background children`() {
        val t = RunTerminal(project, paths)
        val command = "sleep 300 & echo \$! > child.pid; wait"
        val job = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).async {
            t.execute(args("command" to command), t.preview(args("command" to command)))
        }
        val pidFile = File(baseDir, "child.pid")
        val deadline = System.currentTimeMillis() + 10_000
        // The command first hops to the EDT (this thread), so keep dispatching events while waiting.
        while ((!pidFile.exists() || pidFile.readText().isBlank()) && System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(50)
        }
        val pid = pidFile.readText().trim().toLong()
        assertTrue(ProcessHandle.of(pid).map { it.isAlive }.orElse(false))
        runBlocking {
            job.cancel()
            try { withTimeout(10_000) { job.await() } } catch (e: CancellationException) { }
        }
        val killBy = System.currentTimeMillis() + 5_000
        while (ProcessHandle.of(pid).map { it.isAlive }.orElse(false) && System.currentTimeMillis() < killBy) {
            Thread.sleep(50)
        }
        assertFalse("background child survived cancellation", ProcessHandle.of(pid).map { it.isAlive }.orElse(false))
    }

    fun `test approved edit is a single undoable command`() {
        val f = write("undo.txt", "foo bar foo")
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByIoFile(f)!!
        myFixture.configureFromExistingVirtualFile(vf)
        val doc = myFixture.editor.document
        val t = EditFile(project, paths)
        val a = args("path" to "undo.txt", "old_string" to "bar", "new_string" to "BAZ")
        runBlocking { t.execute(a, t.preview(a)) }
        assertEquals("foo BAZ foo", doc.text)
        val undo = com.intellij.openapi.command.undo.UndoManager.getInstance(project)
        val editor = com.intellij.openapi.fileEditor.impl.text.TextEditorProvider.getInstance()
            .getTextEditor(myFixture.editor)
        assertTrue(undo.isUndoAvailable(editor))
        undo.undo(editor)
        assertEquals("foo bar foo", doc.text)
    }
}

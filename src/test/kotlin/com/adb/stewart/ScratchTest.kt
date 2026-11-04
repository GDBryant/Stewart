package com.adb.stewart

import com.adb.stewart.agents.Scratch
import com.adb.stewart.agents.ScratchApprovalGate
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.ToolPreview
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class ScratchTest {
    private lateinit var root: Path
    private lateinit var scratch: Scratch
    private val run = "20261104-101500-abcd"

    @Before fun setUp() {
        root = Files.createTempDirectory("scratch-test").toRealPath()
        scratch = Scratch(root)
    }

    @After fun tearDown() {
        root.toFile().deleteRecursively()
    }

    @Test fun `path layout`() {
        assertEquals(root.resolve(".stewart/scratch/$run/task-2-3"), scratch.taskDir(run, 2, 3))
    }

    @Test fun `invalid segments rejected`() {
        for (bad in listOf("", "..", "a/b", "a\\b")) {
            try {
                scratch.runDir(bad)
                throw AssertionError("expected rejection of '$bad'")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    @Test fun `create then delete on success`() {
        val dir = scratch.create(run, 1, 1)
        assertTrue(Files.isDirectory(dir))
        Files.writeString(dir.resolve("a.txt"), "x")
        assertNull(scratch.finish(dir, success = true))
        assertFalse(Files.exists(dir))
        assertFalse(Files.exists(scratch.runDir(run)))
    }

    @Test fun `success keeps run dir while sibling task remains`() {
        val a = scratch.create(run, 1, 1)
        val b = scratch.create(run, 1, 2)
        scratch.finish(a, true)
        assertTrue(Files.isDirectory(b))
    }

    @Test fun `keep on failure returns path`() {
        val dir = scratch.create(run, 1, 1)
        Files.writeString(dir.resolve("a.txt"), "x")
        assertEquals(dir, scratch.finish(dir, success = false))
        assertTrue(Files.exists(dir.resolve("a.txt")))
    }

    @Test fun `prune removes old keeps recent`() {
        val old = scratch.create("old-run", 1, 1).parent!!
        val recent = scratch.create("new-run", 1, 1).parent!!
        val now = System.currentTimeMillis()
        Files.setLastModifiedTime(old, FileTime.fromMillis(now - TimeUnit.DAYS.toMillis(10)))
        assertEquals(1, scratch.prune(7, now))
        assertFalse(Files.exists(old))
        assertTrue(Files.exists(recent))
    }

    @Test fun `prune with zero retention keeps all`() {
        val old = scratch.create("old-run", 1, 1).parent!!
        Files.setLastModifiedTime(old, FileTime.fromMillis(0))
        assertEquals(0, scratch.prune(0))
        assertTrue(Files.exists(old))
    }

    @Test fun `prune without scratch dir is a no-op`() {
        assertEquals(0, scratch.prune(7))
    }

    @Test fun `isInside accepts files in scratch dir`() {
        val dir = scratch.create(run, 1, 1)
        assertTrue(scratch.isInside(dir.resolve("out.txt"), run))
        assertTrue(scratch.isInside(dir.resolve("new/deeper/out.txt"), run))
    }

    @Test fun `isInside rejects escapes siblings and other runs`() {
        val dir = scratch.create(run, 1, 1)
        assertFalse(scratch.isInside(dir.resolve("../../../../src/x.kt"), run))
        assertFalse(scratch.isInside(scratch.scratchRoot.resolve("$run-evil/task-1-1/x"), run))
        assertFalse(scratch.isInside(scratch.scratchRoot.resolve("other/task-1-1/x"), run))
        assertFalse(scratch.isInside(root.resolve("x.kt"), run))
        assertFalse(scratch.isInside(scratch.runDir(run), run))
        assertFalse(scratch.isInside(dir.resolve("x"), ""))
    }

    @Test fun `isInside rejects symlink out of scratch`() {
        val dir = scratch.create(run, 1, 1)
        val outside = Files.createDirectories(root.resolve("outside"))
        val link = dir.resolve("link")
        symlink(link, outside)
        assertFalse(scratch.isInside(link.resolve("x.txt"), run))
    }

    private fun symlink(link: Path, target: Path) {
        val ok = try {
            Files.createSymbolicLink(link, target)
            true
        } catch (_: UnsupportedOperationException) {
            false
        } catch (_: java.io.IOException) {
            false
        }
        assumeTrue("symlinks unsupported", ok)
    }

    @Test fun `isInside rejects dangling symlink`() {
        val dir = scratch.create(run, 1, 1)
        symlink(dir.resolve("dangling"), root.resolve("does-not-exist"))
        assertFalse(scratch.isInside(dir.resolve("dangling"), run))
        assertFalse(scratch.isInside(dir.resolve("dangling/x.txt"), run))
    }

    @Test fun `isInside rejects symlinked run dir`() {
        val outside = Files.createDirectories(root.resolve("outside"))
        Files.createDirectories(scratch.scratchRoot)
        symlink(scratch.runDir(run), outside)
        assertFalse(scratch.isInside(scratch.runDir(run).resolve("task-1-1/x.txt"), run))
        assertFalse(scratch.isInside(outside.resolve("x.txt"), run))
    }

    @Test fun `finish refuses dir outside scratch`() {
        val victim = Files.createDirectories(root.resolve("victim"))
        Files.writeString(victim.resolve("keep.txt"), "x")
        assertEquals(victim, scratch.finish(victim, success = true))
        assertTrue(Files.exists(victim.resolve("keep.txt")))
        assertEquals(scratch.scratchRoot, scratch.finish(scratch.scratchRoot.also { Files.createDirectories(it) }, true))
        assertTrue(Files.isDirectory(scratch.scratchRoot))
        val escape = scratch.create(run, 1, 1).resolve("../../../../victim")
        assertEquals(escape, scratch.finish(escape, success = true))
        assertTrue(Files.exists(victim.resolve("keep.txt")))
    }

    @Test fun `prune skips symlinked run dirs`() {
        val target = Files.createDirectories(root.resolve("elsewhere"))
        Files.writeString(target.resolve("keep.txt"), "x")
        Files.setLastModifiedTime(target, FileTime.fromMillis(0))
        Files.createDirectories(scratch.scratchRoot)
        symlink(scratch.scratchRoot.resolve("linked"), target)
        assertEquals(0, scratch.prune(1))
        assertTrue(Files.exists(target.resolve("keep.txt")))
    }

    @Test fun `prune keeps the live run even when old`() {
        val live = scratch.create(run, 1, 1).parent!!
        Files.setLastModifiedTime(live, FileTime.fromMillis(0))
        assertEquals(0, scratch.prune(1, currentRunId = run))
        assertTrue(Files.exists(live))
        assertEquals(1, scratch.prune(1))
    }

    @Test fun `prune uses newest file mtime not dir mtime`() {
        val dir = scratch.create(run, 1, 1)
        val f = dir.resolve("a.txt")
        Files.writeString(f, "x")
        val now = System.currentTimeMillis()
        Files.setLastModifiedTime(dir, FileTime.fromMillis(0))
        Files.setLastModifiedTime(dir.parent, FileTime.fromMillis(0))
        assertEquals(0, scratch.prune(1, now))
        Files.setLastModifiedTime(f, FileTime.fromMillis(0))
        assertEquals(1, scratch.prune(1, now))
    }

    @Test fun `ignore hints include stewart dir`() {
        assertTrue(".stewart/" in Scratch.IGNORE_HINTS)
    }

    private fun gate(runId: String = run): Pair<ApprovalGate, MutableList<String>> {
        val prompted = mutableListOf<String>()
        val inner = ApprovalGate { c, _ -> prompted.add(c.name); ApprovalDecision.Rejected("prompted") }
        return ScratchApprovalGate(inner, scratch) { runId } to prompted
    }

    private fun review(g: ApprovalGate, tool: String, path: Path, preview: ToolPreview? = ToolPreview.FileChange(path.toString(), null, "x")) =
        runBlocking { g.review(ToolCall("1", tool, JsonObject(emptyMap())), preview) }

    @Test fun `gate approves scratch writes without prompting`() {
        val dir = scratch.create(run, 1, 1)
        val (g, prompted) = gate()
        assertEquals(ApprovalDecision.Approved, review(g, "WriteFile", dir.resolve("a.txt")))
        assertEquals(ApprovalDecision.Approved, review(g, "EditFile", dir.resolve("a.txt")))
        assertTrue(prompted.isEmpty())
    }

    @Test fun `gate prompts for outside escape sibling and other tools`() {
        val dir = scratch.create(run, 1, 1)
        val (g, prompted) = gate()
        val cases = listOf(
            root.resolve("src/x.kt"),
            dir.resolve("../../../../src/x.kt"),
            scratch.scratchRoot.resolve("$run-evil/task-1-1/x.txt"),
        )
        for (p in cases) assertTrue(review(g, "WriteFile", p) is ApprovalDecision.Rejected)
        assertEquals(3, prompted.size)
        assertTrue(review(g, "RunTerminal", dir.resolve("a.txt")) is ApprovalDecision.Rejected)
        assertTrue(review(g, "WriteFile", dir.resolve("a.txt"), ToolPreview.Other) is ApprovalDecision.Rejected)
        assertTrue(review(g, "WriteFile", dir.resolve("a.txt"), null) is ApprovalDecision.Rejected)
        assertEquals(6, prompted.size)
    }

    @Test fun `gate with blank run id never auto-approves`() {
        val dir = scratch.create(run, 1, 1)
        val (g, prompted) = gate("")
        assertTrue(review(g, "WriteFile", dir.resolve("a.txt")) is ApprovalDecision.Rejected)
        assertEquals(1, prompted.size)
    }

    @Test fun `gate prompts for unregistered dir in same run`() {
        scratch.create(run, 1, 1)
        val other = Files.createDirectories(scratch.taskDir(run, 9, 9))
        val (g, prompted) = gate()
        assertTrue(review(g, "WriteFile", other.resolve("a.txt")) is ApprovalDecision.Rejected)
        assertEquals(1, prompted.size)
    }

    @Test fun `gate prompts after finish unregisters`() {
        val dir = scratch.create(run, 1, 1)
        scratch.finish(dir, success = false)
        val (g, prompted) = gate()
        assertTrue(review(g, "WriteFile", dir.resolve("a.txt")) is ApprovalDecision.Rejected)
        assertEquals(1, prompted.size)
    }
}

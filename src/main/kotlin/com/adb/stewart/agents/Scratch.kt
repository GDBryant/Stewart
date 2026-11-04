package com.adb.stewart.agents

import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.provider.ToolCall
import com.intellij.openapi.diagnostic.Logger
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Per-run scratch space `<project>/.stewart/scratch/<runId>/task-<milestoneId>-<taskId>/`.
 * Deleted on success, kept (path returned for messages) on failure or cancel.
 */
class Scratch(projectRoot: Path) {
    private val root: Path = projectRoot.toAbsolutePath().normalize()

    val scratchRoot: Path get() = root.resolve(DIR).resolve("scratch")

    fun runDir(runId: String): Path = scratchRoot.resolve(safe(runId))

    fun taskDir(runId: String, milestoneId: Any, taskId: Any): Path =
        runDir(runId).resolve("task-${safe(milestoneId.toString())}-${safe(taskId.toString())}")

    private val registered: MutableSet<Path> = ConcurrentHashMap.newKeySet()

    /** Creates and returns the task directory, registering it for scratch auto-approval until [finish]. */
    fun create(runId: String, milestoneId: Any, taskId: Any): Path {
        val dir = Files.createDirectories(taskDir(runId, milestoneId, taskId))
        if (isInside(dir.resolve("x"), runId)) canonical(dir)?.let { registered.add(it) }
        return dir
    }

    /**
     * Deletes [dir] on success (and its run dir once empty); on failure keeps it. Returns the kept path or null.
     * Refuses (returns [dir], deletes nothing) unless [dir] is strictly inside the scratch root once canonicalised.
     */
    fun finish(dir: Path, success: Boolean): Path? {
        val canon = canonical(dir.toAbsolutePath().normalize())
        canon?.let { registered.remove(it) }
        if (!success) return dir
        val rootCanon = scratchRootCanon()
        if (canon == null || rootCanon == null || canon == rootCanon || !canon.startsWith(rootCanon)) {
            LOG.debug("Scratch finish refused outside scratch root: $dir")
            return dir
        }
        deleteTree(dir)
        val run = dir.parent
        if (run != null && run.parent == scratchRoot && !Files.isSymbolicLink(run)) {
            try {
                Files.deleteIfExists(run) // only succeeds when empty
            } catch (_: IOException) {
            }
        }
        return null
    }

    /**
     * Deletes the whole run dir (including task dirs kept by earlier failed splits) and unregisters its tasks.
     * Refuses unless the run dir is strictly inside the scratch root and not a symlink. Returns true when deleted.
     */
    fun deleteRun(runId: String): Boolean {
        val run = runDir(runId)
        if (!Files.exists(run, LinkOption.NOFOLLOW_LINKS)) return false
        if (Files.isSymbolicLink(run)) return false
        val canon = canonical(run.toAbsolutePath().normalize())
        val rootCanon = scratchRootCanon()
        if (canon == null || rootCanon == null || canon == rootCanon || !canon.startsWith(rootCanon)) {
            LOG.debug("Scratch deleteRun refused outside scratch root: $run")
            return false
        }
        registered.removeIf { it.startsWith(canon) }
        deleteTree(run)
        return !Files.exists(run, LinkOption.NOFOLLOW_LINKS)
    }

    /**
     * Deletes run dirs whose newest file is older than [retentionDays]; 0 or less keeps everything.
     * Never touches [currentRunId] or symlinked entries. Returns the number deleted.
     */
    fun prune(retentionDays: Int, now: Long = System.currentTimeMillis(), currentRunId: String? = null): Int {
        if (retentionDays <= 0 || scratchRootCanon() == null ||
            !Files.isDirectory(scratchRoot, LinkOption.NOFOLLOW_LINKS)
        ) return 0
        val cutoff = now - TimeUnit.DAYS.toMillis(retentionDays.toLong())
        var deleted = 0
        try {
            Files.newDirectoryStream(scratchRoot).use { stream ->
                for (run in stream) {
                    if (Files.isSymbolicLink(run) || !Files.isDirectory(run, LinkOption.NOFOLLOW_LINKS)) continue
                    if (!currentRunId.isNullOrBlank() && run.fileName.toString() == currentRunId) continue
                    if (newestModified(run) < cutoff) {
                        deleteTree(run)
                        deleted++
                    }
                }
            }
        } catch (e: IOException) {
            LOG.debug("Scratch prune failed: ${e.message}")
        }
        return deleted
    }

    /** Newest mtime of any regular file under [run] (symlinks skipped); the dir's own mtime when it has none. */
    private fun newestModified(run: Path): Long {
        var newest = Long.MIN_VALUE
        try {
            Files.walk(run).use { s ->
                s.forEach {
                    if (Files.isRegularFile(it, LinkOption.NOFOLLOW_LINKS)) {
                        newest = maxOf(newest, Files.getLastModifiedTime(it, LinkOption.NOFOLLOW_LINKS).toMillis())
                    }
                }
            }
        } catch (_: IOException) {
        }
        return if (newest == Long.MIN_VALUE) Files.getLastModifiedTime(run, LinkOption.NOFOLLOW_LINKS).toMillis() else newest
    }

    /**
     * True when [path] lies strictly inside this run's scratch dir. Both sides are normalised and
     * symlink-resolved, so `..` escapes, symlinks (including dangling or symlinked run dirs) and
     * sibling-prefix dirs (`<runId>-evil`) fail.
     */
    fun isInside(path: Path, runId: String): Boolean = resolveInside(path, runId) != null

    /** True when [path] is strictly inside a task dir registered via [create] for [runId] and not yet finished. */
    fun isInRegisteredTask(path: Path, runId: String): Boolean {
        val target = resolveInside(path, runId) ?: return false
        return registered.any { target != it && target.startsWith(it) && it.parent == runCanon(runId) }
    }

    private fun scratchRootCanon(): Path? {
        val rootCanon = canonical(root) ?: return null
        val expected = rootCanon.resolve(DIR).resolve("scratch")
        return if (canonical(scratchRoot) == expected) expected else null
    }

    /** Canonical run dir, or null when it (or the scratch root) is a symlink escaping the expected location. */
    private fun runCanon(runId: String): Path? {
        if (runId.isBlank()) return null
        val rootCanon = scratchRootCanon() ?: return null
        val expected = try {
            rootCanon.resolve(safe(runId))
        } catch (_: IllegalArgumentException) {
            return null
        }
        return if (canonical(runDir(runId)) == expected) expected else null
    }

    private fun resolveInside(path: Path, runId: String): Path? {
        val dir = runCanon(runId) ?: return null
        val target = canonical(path.toAbsolutePath().normalize()) ?: return null
        return if (target != dir && target.startsWith(dir)) target else null
    }

    /** Real path of the deepest existing ancestor plus the non-existent tail; null on dangling symlinks. */
    private fun canonical(p: Path): Path? {
        var ancestor = p
        val tail = ArrayDeque<Path>()
        while (!Files.exists(ancestor, LinkOption.NOFOLLOW_LINKS)) {
            val parent = ancestor.parent ?: return null
            tail.addFirst(ancestor.fileName)
            ancestor = parent
        }
        var real = try {
            ancestor.toRealPath()
        } catch (_: IOException) {
            return null
        }
        for (seg in tail) real = real.resolve(seg).normalize()
        return real
    }

    private fun deleteTree(p: Path) {
        try {
            if (!Files.exists(p, LinkOption.NOFOLLOW_LINKS)) return
            Files.walk(p).use { s -> s.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
        } catch (e: IOException) {
            LOG.debug("Scratch delete failed for $p: ${e.message}")
        }
    }

    private fun safe(s: String): String {
        require(s.isNotBlank() && s.none { it == '/' || it == '\\' } && s != "." && s != "..") { "invalid scratch segment: $s" }
        return s
    }

    companion object {
        const val DIR = ".stewart"

        /** Entries suggested for VCS ignore and excluded from FindFiles and Search. */
        val IGNORE_HINTS: List<String> = listOf("$DIR/")

        private val LOG = Logger.getInstance(Scratch::class.java)
    }
}

/**
 * Approves WriteFile and EditFile changes inside task dirs registered for the current run; everything else goes
 * to [inner]. [currentRunId] is read per call so the rule covers only the live run.
 */
class ScratchApprovalGate(
    private val inner: ApprovalGate,
    private val scratch: Scratch,
    private val currentRunId: () -> String,
) : ApprovalGate {
    override suspend fun review(call: ToolCall, preview: ToolPreview?): ApprovalDecision {
        if ((call.name == "WriteFile" || call.name == "EditFile") && preview is ToolPreview.FileChange &&
            scratch.isInRegisteredTask(Path.of(preview.path), currentRunId())
        ) {
            LOG.debug("Auto-approved scratch write: ${preview.path}")
            return ApprovalDecision.Approved
        }
        return inner.review(call, preview)
    }

    private companion object {
        private val LOG = Logger.getInstance(ScratchApprovalGate::class.java)
    }
}

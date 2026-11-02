package com.adb.stewart

import com.adb.stewart.chat.GitDiff
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class GitDiffTest {

    private fun gitAvailable(): Boolean = try {
        ProcessBuilder("git", "--version").start().waitFor() == 0
    } catch (e: Exception) {
        false
    }

    private fun git(dir: Path, vararg args: String) {
        val cmd = listOf("git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false") + args
        val p = ProcessBuilder(cmd).directory(dir.toFile()).redirectErrorStream(true).start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        assertEquals(out, 0, p.waitFor())
    }

    private fun repo(): Path {
        val dir = Files.createTempDirectory("gitdiff")
        git(dir, "init", "-q")
        return dir
    }

    @Test
    fun `no directory is not a repo`() {
        assertEquals(GitDiff.Result.NotRepo("No project directory"), GitDiff.read(null))
    }

    @Test
    fun `missing git binary is reported`() {
        assertEquals(
            GitDiff.Result.NotRepo("git not available"),
            GitDiff.read(Files.createTempDirectory("gitdiff"), git = "/nonexistent/git"),
        )
    }

    @Test
    fun `plain directory is not a repo`() {
        assumeTrue(gitAvailable())
        val dir = Files.createTempDirectory("gitdiff")
        // GIT_CEILING_DIRECTORIES is not settable here; the temp dir is assumed to be outside any repo.
        assertEquals(GitDiff.Result.NotRepo("Not a git repository"), GitDiff.read(dir))
    }

    @Test
    fun `repo without commits has nothing to diff against`() {
        assumeTrue(gitAvailable())
        assertEquals(GitDiff.Result.NoCommits, GitDiff.read(repo()))
    }

    @Test
    fun `clean repo has no changes and an edit shows up in the diff`() {
        assumeTrue(gitAvailable())
        val dir = repo()
        Files.writeString(dir.resolve("a.txt"), "one\n")
        git(dir, "add", "a.txt")
        git(dir, "commit", "-q", "-m", "init")
        assertEquals(GitDiff.Result.NoChanges, GitDiff.read(dir))
        // color.ui=always must not leak escape codes into the diff.
        git(dir, "config", "color.ui", "always")
        Files.writeString(dir.resolve("a.txt"), "two\n")
        val diff = GitDiff.read(dir) as GitDiff.Result.Diff
        assertTrue(diff.text.contains("-one\n+two"))
        assertTrue(!diff.text.contains("\u001b["))
    }
}

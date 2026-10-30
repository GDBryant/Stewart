package com.aijb.assistant.chat

import java.io.File
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Read-only `git diff HEAD` for `/review`; runs git directly, so no approval prompt. Call off the EDT. */
object GitDiff {

    sealed interface Result {
        data class Diff(val text: String) : Result
        data object NoChanges : Result
        data object NoCommits : Result
        data class NotRepo(val message: String) : Result
    }

    private class Output(val exit: Int, val stdout: String)

    // User config (color.ui=always, diff.external, pagers) must not change the output.
    private val DIFF = listOf("--no-pager", "-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "HEAD")

    fun read(dir: Path?, git: String = "git", timeoutSeconds: Long = 20): Result {
        if (dir == null) return Result.NotRepo("No project directory")
        val inside = run(git, dir, listOf("rev-parse", "--is-inside-work-tree"), timeoutSeconds)
            ?: return Result.NotRepo("git not available")
        if (inside.exit != 0 || inside.stdout.trim() != "true") return Result.NotRepo("Not a git repository")
        val head = run(git, dir, listOf("rev-parse", "--verify", "-q", "HEAD"), timeoutSeconds)
            ?: return Result.NotRepo("git not available")
        if (head.exit != 0) return Result.NoCommits
        val diff = run(git, dir, DIFF, timeoutSeconds) ?: return Result.NotRepo("git diff failed")
        if (diff.exit != 0) return Result.NotRepo("git diff failed (exit ${diff.exit})")
        return if (diff.stdout.isBlank()) Result.NoChanges else Result.Diff(diff.stdout)
    }

    /** Null when git cannot be started or times out. */
    private fun run(git: String, dir: Path, args: List<String>, timeoutSeconds: Long): Output? {
        val process = try {
            ProcessBuilder(listOf(git) + args)
                .directory(dir.toFile())
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .redirectInput(ProcessBuilder.Redirect.from(File(if (File.separatorChar == '\\') "NUL" else "/dev/null")))
                .start()
        } catch (e: Exception) {
            return null
        }
        val stdout = CompletableFuture.supplyAsync { process.inputStream.readBytes().toString(Charsets.UTF_8) }
        if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            return null
        }
        return Output(process.exitValue(), stdout.get(timeoutSeconds, TimeUnit.SECONDS))
    }
}

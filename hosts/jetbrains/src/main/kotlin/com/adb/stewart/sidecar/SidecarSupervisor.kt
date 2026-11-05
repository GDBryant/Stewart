package com.adb.stewart.sidecar

import com.adb.stewart.rpc.Link
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import kotlinx.serialization.json.JsonElement
import java.io.File
import java.util.concurrent.CompletableFuture

fun interface ProcessLauncher {
    fun launch(command: List<String>, dir: File?): Process
}

enum class SupervisorState { STOPPED, STARTING, RUNNING, DEGRADED }

/**
 * Owns the Node sidecar process and its NDJSON link. Restarts a crashed sidecar
 * with exponential backoff; a crash loop (`maxStartsInWindow` starts inside
 * `windowMs`) degrades to an error state instead of looping forever.
 */
class SidecarSupervisor(
    private val command: List<String>,
    private val workingDir: File? = null,
    private val launcher: ProcessLauncher = ProcessLauncher { cmd, dir -> ProcessBuilder(cmd).directory(dir).start() },
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val schedule: (Long, () -> Unit) -> Unit = { d, t -> kotlin.concurrent.thread(isDaemon = true) { Thread.sleep(d); t() } },
    private val windowMs: Long = 60_000,
    private val maxStartsInWindow: Int = 5,
) : Disposable {

    @Volatile
    var state: SupervisorState = SupervisorState.STOPPED
        private set

    var link: Link? = null
        private set

    var onStateChanged: ((SupervisorState) -> Unit)? = null
    var onLinkReady: ((Link) -> Unit)? = null
    var onExit: ((Int) -> Unit)? = null
    var lastError: String? = null
        private set

    private val startTimes = ArrayDeque<Long>()
    private var restartAttempt = 0
    private var spawnedAt = 0L
    private var process: Process? = null
    private var disposed = false
    private val lock = Any()

    fun request(method: String, params: JsonElement? = null): CompletableFuture<JsonElement?> {
        val l = link ?: return CompletableFuture<JsonElement?>().apply {
            completeExceptionally(IllegalStateException("sidecar not running (state=$state)"))
        }
        return l.request(method, params)
    }

    fun notify(method: String, params: JsonElement? = null) {
        link?.notify(method, params)
    }

    fun start() {
        synchronized(lock) {
            if (disposed || state == SupervisorState.RUNNING || state == SupervisorState.STARTING || state == SupervisorState.DEGRADED) return
            setState(SupervisorState.STARTING)
            val now = clock()
            while (startTimes.isNotEmpty() && now - startTimes.first() > windowMs) startTimes.removeFirst()
            if (startTimes.size >= maxStartsInWindow) {
                lastError = "sidecar crashed $maxStartsInWindow times in ${windowMs / 1000}s"
                setState(SupervisorState.DEGRADED)
                return
            }
            startTimes.addLast(now)
            spawnedAt = now
            val p = try {
                launcher.launch(command, workingDir)
            } catch (e: Exception) {
                lastError = "sidecar launch failed: ${e.message}"
                setState(SupervisorState.STOPPED)
                scheduleRestart()
                return
            }
            process = p
            val l = Link(p.inputStream, p.outputStream)
            link = l
            l.onClose = { if (!disposed) setState(SupervisorState.STOPPED) }
            l.start()
            setState(SupervisorState.RUNNING)
            onLinkReady?.invoke(l)
            kotlin.concurrent.thread(name = "stewart-sidecar-wait", isDaemon = true) {
                val code = try {
                    p.waitFor()
                } catch (_: InterruptedException) {
                    -1
                }
                onProcessExit(code)
            }
        }
    }

    private fun onProcessExit(code: Int) {
        synchronized(lock) {
            if (disposed) return
            link?.close("sidecar exited ($code)")
            link = null
            process = null
            onExit?.invoke(code)
            if (state != SupervisorState.DEGRADED) {
                if (clock() - spawnedAt > 10_000) restartAttempt = 0
                setState(SupervisorState.STOPPED)
                if (code != 0) scheduleRestart()
            }
        }
    }

    private fun scheduleRestart() {
        val delay = minOf(500L shl restartAttempt.coerceAtMost(6), 30_000L)
        restartAttempt++
        schedule(delay) { if (!disposed && state == SupervisorState.STOPPED) start() }
    }

    /** Leaves DEGRADED state and starts again (user "Restart" action). */
    fun restart() {
        synchronized(lock) {
            if (disposed) return
            startTimes.clear()
            restartAttempt = 0
            if (state == SupervisorState.DEGRADED) setState(SupervisorState.STOPPED)
        }
        start()
    }

    private fun setState(s: SupervisorState) {
        state = s
        onStateChanged?.invoke(s)
    }

    override fun dispose() {
        synchronized(lock) {
            disposed = true
            link?.close("disposed")
            link = null
            process?.let { p ->
                try {
                    com.intellij.execution.process.OSProcessUtil.killProcessTree(p)
                } catch (_: Throwable) {
                    /* fall through to forcible destroy */
                }
                p.destroyForcibly()
            }
            process = null
            setState(SupervisorState.STOPPED)
        }
    }
}

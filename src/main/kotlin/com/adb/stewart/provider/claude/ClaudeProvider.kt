package com.adb.stewart.provider.claude

import com.adb.stewart.debug.DebugLogSink
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Usage
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

data class ClaudeLoginState(
    val loggedIn: Boolean,
    val authMethod: String?,
    val subscriptionType: String?,
    val detail: String?,
)

class ClaudeProvider(
    private val cliPath: String = "claude",
    private val models: List<String> = listOf("sonnet", "opus", "haiku"),
    private val extraEnv: Map<String, String> = emptyMap(),
    private val killGrace: Duration = 2.seconds,
    internal val authTimeoutMillis: Long = 20_000,
) : ModelProvider {

    override val id: String = "claude"

    override fun supportsNativeTools(model: String): Boolean = false

    override fun supportsImages(model: String): Boolean = true

    override suspend fun listModels(): List<ModelInfo> =
        models.map { ClaudeModels.normalize(it) }.distinct().map { ModelInfo(ModelRef(id, it), it) }

    private fun childEnv(): Map<String, String> =
        (System.getenv() + extraEnv).toMutableMap().apply {
            remove("ANTHROPIC_API_KEY")
            remove("ANTHROPIC_AUTH_TOKEN")
        }

    private fun deleteRecursively(dir: File) {
        dir.walkBottomUp().forEach { it.delete() }
    }

    override fun chat(request: ChatRequest): Flow<ProviderEvent> = channelFlow {
        if (request.tools.isNotEmpty()) {
            send(ProviderEvent.Failed("Claude does not support native tools", code = "native_tools_unsupported"))
            return@channelFlow
        }
        val input = ClaudeTranscript.prepare(request.messages)
        val system = input.system
        val stdinText = if (input.hasImages) input.streamJsonLine() + "\n" else input.text
        DebugLogSink.log(
            "outgoing", id, request.model, input.logText(),
        )
        val cwd = Files.createTempDirectory("stewart-claude-").toFile()
        var promptFile: File? = null
        var process: Process? = null
        try {
            promptFile = Files.createTempFile("stewart-claude-prompt", ".txt").toFile()
            promptFile.writeText(system, Charsets.UTF_8)
            val argv = ClaudeTranscript.argv(
                cliPath, ClaudeModels.normalize(request.model), promptFile.absolutePath, input.hasImages,
            )
            val pb = ProcessBuilder(argv)
            pb.environment().clear()
            pb.environment().putAll(childEnv())
            pb.directory(cwd)
            val proc = try {
                pb.start()
            } catch (e: java.io.IOException) {
                DebugLogSink.log("error", id, request.model, "cannot start Claude CLI at $cliPath: ${e.message}")
                send(ProviderEvent.Failed("cannot start Claude CLI at $cliPath: ${e.message}", e, "cli_not_found"))
                return@channelFlow
            }
            process = proc
            val parser = ClaudeStreamParser()
            val stderr = StringBuilder()
            val io = coroutineContext.job
            val stderrJob = launch(Dispatchers.IO) {
                runCatching {
                    proc.errorStream.bufferedReader().use { r ->
                        val buf = CharArray(4096)
                        while (true) {
                            val n = r.read(buf)
                            if (n <= 0) break
                            if (stderr.length < 65536) {
                                stderr.append(buf, 0, minOf(n, 65536 - stderr.length))
                            }
                        }
                    }
                }
            }
            val stdinJob = launch(Dispatchers.IO) {
                runCatching {
                    proc.outputStream.bufferedWriter(Charsets.UTF_8).use { w ->
                        w.write(stdinText)
                    }
                }
            }
            val readerJob = launch(Dispatchers.IO) {
                runCatching {
                    proc.inputStream.bufferedReader().useLines { lines ->
                        for (line in lines) {
                            if (DebugLogSink.isEnabled) {
                                DebugLogSink.log("incoming", id, request.model, line)
                            }
                            for (ev in parser.feed(line)) {
                                if (!isClosedForSend) send(ev)
                            }
                            if (parser.failedEmitted || parser.toolTurnEnded) {
                                // Kill children first: an orphan holding stderr would block joinAll.
                                proc.descendants().forEach { it.destroyForcibly() }
                                proc.destroy()
                                break
                            }
                        }
                    }
                }
            }
            val exitCode = withContext(Dispatchers.IO) {
                while (proc.isAlive) {
                    coroutineContext.ensureActive()
                    try {
                        proc.waitFor(50, TimeUnit.MILLISECONDS)
                    } catch (e: InterruptedException) {
                        break
                    }
                }
                if (proc.isAlive) -1 else proc.exitValue()
            }
            kotlinx.coroutines.joinAll(readerJob, stderrJob, stdinJob)
            if (stderr.isNotEmpty()) {
                DebugLogSink.log("stderr", id, request.model, stderr.toString())
            }
            if (!parser.failedEmitted) {
                when {
                    parser.toolTurnEnded || (parser.cutPending && !parser.resultSeen) -> {
                        send(ProviderEvent.Completed("tool_calls", parser.turnUsage()))
                    }
                    !parser.resultSeen -> {
                        if (exitCode == 0) {
                            DebugLogSink.log("error", id, request.model, "stream ended before completion")
                            send(ProviderEvent.Failed("stream ended before completion", code = "incomplete_stream"))
                        } else {
                            val tail = stderr.toString().takeLast(2000)
                            val code = if (parser.classifyStderr(tail) == "auth") "auth" else "cli_exit"
                            send(ProviderEvent.Failed("Claude CLI exited with code $exitCode: $tail", code = code))
                        }
                    }
                    parser.resultIsError -> {}
                    exitCode != 0 -> {
                        send(ProviderEvent.Failed("Claude CLI exited with code $exitCode", code = "cli_exit"))
                    }
                    else -> {
                        send(ProviderEvent.Completed(parser.finishReason, parser.turnUsage()))
                    }
                }
            }
        } finally {
            withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                process?.let { proc ->
                    proc.descendants().forEach { it.destroy() }
                    proc.destroy()
                    val deadline = System.nanoTime() + killGrace.inWholeNanoseconds
                    while (proc.isAlive && System.nanoTime() < deadline) {
                        kotlinx.coroutines.delay(25)
                    }
                    if (proc.isAlive) proc.destroyForcibly()
                    proc.descendants().forEach {
                        it.destroyForcibly()
                    }
                }
                runCatching { promptFile?.delete() }
                runCatching { deleteRecursively(cwd) }
            }
        }
    }

    suspend fun loginStatus(): ClaudeLoginState = withContext(Dispatchers.IO) {
        val cwd = Files.createTempDirectory("stewart-claude-").toFile()
        var process: Process? = null
        try {
            val pb = ProcessBuilder(cliPath, "auth", "status")
            pb.environment().clear()
            pb.environment().putAll(childEnv())
            pb.directory(cwd)
            val proc = try {
                pb.start()
            } catch (e: java.io.IOException) {
                return@withContext ClaudeLoginState(false, null, null, "cannot start CLI: ${e.message}")
            }
            process = proc
            val outBuilder = StringBuilder()
            val reader = launch {
                runCatching {
                    proc.inputStream.bufferedReader().use { outBuilder.append(it.readText()) }
                }
            }
            val deadline = System.currentTimeMillis() + authTimeoutMillis
            while (proc.isAlive && System.currentTimeMillis() < deadline) {
                kotlinx.coroutines.delay(25)
            }
            if (proc.isAlive) {
                proc.destroy()
                proc.descendants().forEach { it.destroyForcibly() }
                proc.destroyForcibly()
                reader.cancel()
                return@withContext ClaudeLoginState(false, null, null, "auth status timed out")
            }
            reader.join()
            val out = outBuilder.toString()
            if (proc.exitValue() != 0) {
                return@withContext ClaudeLoginState(false, null, null, "auth status exit ${proc.exitValue()}")
            }
            val obj = try {
                Json.parseToJsonElement(out)
            } catch (e: Exception) {
                return@withContext ClaudeLoginState(false, null, null, "non-JSON auth status")
            }
            if (obj !is JsonObject) return@withContext ClaudeLoginState(false, null, null, "non-JSON auth status")
            ClaudeLoginState(
                loggedIn = obj["loggedIn"]?.jsonPrimitive?.booleanOrNull == true,
                authMethod = obj["authMethod"]?.jsonPrimitive?.content,
                subscriptionType = obj["subscriptionType"]?.jsonPrimitive?.content,
                detail = null,
            )
        } finally {
            process?.let { it.descendants().forEach { d -> d.destroyForcibly() }; it.destroyForcibly() }
            runCatching { deleteRecursively(cwd) }
        }
    }
}

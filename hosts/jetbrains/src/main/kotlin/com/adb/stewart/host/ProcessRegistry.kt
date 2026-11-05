package com.adb.stewart.host

import com.intellij.execution.process.OSProcessUtil
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Processes started for the sidecar's `host.proc.run`. Output streams are pushed
 * back as `proc.output` notifications and exit as `proc.exit`, keyed by the
 * caller-supplied handle id.
 */
class ProcessRegistry(private val notify: (String, JsonObject) -> Unit) {
    private val handles = ConcurrentHashMap<String, Process>()

    fun run(handle: String, argv: List<String>, cwd: String?, env: Map<String, String>?): JsonElement {
        val pb = ProcessBuilder(argv)
        if (!cwd.isNullOrBlank()) pb.directory(File(cwd))
        env?.let { pb.environment().putAll(it) }
        pb.redirectErrorStream(true)
        val p = pb.start()
        handles[handle] = p
        thread(name = "stewart-proc-out-$handle", isDaemon = true) {
            try {
                val reader = p.inputStream.bufferedReader(Charsets.UTF_8)
                val buf = CharArray(8192)
                while (true) {
                    val n = reader.read(buf)
                    if (n < 0) break
                    if (n > 0) notify("proc.output", buildJsonObject {
                        put("handle", JsonPrimitive(handle))
                        put("data", JsonPrimitive(String(buf, 0, n)))
                    })
                }
            } catch (_: IOException) {
                /* stream closed on kill */
            }
        }
        thread(name = "stewart-proc-wait-$handle", isDaemon = true) {
            val code = try {
                p.waitFor()
            } catch (_: InterruptedException) {
                -1
            }
            handles.remove(handle)
            notify("proc.exit", buildJsonObject {
                put("handle", JsonPrimitive(handle))
                put("code", JsonPrimitive(code))
            })
        }
        return JsonObject(mapOf("ok" to JsonPrimitive(true)))
    }

    fun write(handle: String, data: String) {
        val p = handles[handle] ?: throw IOException("no such process: $handle")
        p.outputStream.write(data.toByteArray(Charsets.UTF_8))
        p.outputStream.flush()
    }

    fun cancel(handle: String) {
        handles[handle]?.destroy()
    }

    fun killTree(handle: String) {
        val p = handles.remove(handle) ?: return
        try {
            OSProcessUtil.killProcessTree(p)
        } catch (_: Throwable) {
            p.destroyForcibly()
        }
    }

    fun killAll() {
        for (h in handles.keys.toList()) killTree(h)
    }

    fun running(): Set<String> = handles.keys.toSet()
}

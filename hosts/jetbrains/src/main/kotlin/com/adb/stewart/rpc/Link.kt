package com.adb.stewart.rpc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * NDJSON JSON-RPC over a byte stream pair, mirroring packages/sidecar/src/rpc.ts:
 * requests flow both ways (IDE asks core, core asks the IDE for HostPort work),
 * framing is one JSON object per line, oversized lines are rejected.
 */
class Link(
    private val input: InputStream,
    private val output: OutputStream,
    private val maxLineBytes: Int = MAX_LINE_BYTES,
) {
    companion object {
        const val MAX_LINE_BYTES = 16 * 1024 * 1024
        private val json = Json { ignoreUnknownKeys = true }
    }

    private val nextId = AtomicLong(1)
    private val pending = HashMap<Long, CompletableFuture<JsonElement?>>()
    private val writeLock = Any()
    private var requestHandler: (String, JsonElement?) -> CompletableFuture<JsonElement?> = { m, _ ->
        CompletableFuture<JsonElement?>().apply { completeExceptionally(IOException("no request handler for $m")) }
    }
    private val notificationHandlers = mutableListOf<(String, JsonElement?) -> Unit>()
    private var reader: Thread? = null

    @Volatile
    var closed = false
        private set

    var onClose: ((String) -> Unit)? = null

    fun onRequest(h: (String, JsonElement?) -> CompletableFuture<JsonElement?>) {
        requestHandler = h
    }

    fun onNotification(h: (String, JsonElement?) -> Unit) {
        synchronized(notificationHandlers) { notificationHandlers.add(h) }
    }

    fun notify(method: String, params: JsonElement? = null) {
        if (closed) return
        writeLine(
            buildJsonObject {
                put("method", JsonPrimitive(method))
                if (params != null) put("params", params)
            }.toString(),
        )
    }

    fun request(method: String, params: JsonElement? = null): CompletableFuture<JsonElement?> {
        if (closed) {
            return CompletableFuture<JsonElement?>().apply { completeExceptionally(IOException("rpc link closed")) }
        }
        val id = nextId.getAndIncrement()
        val fut = CompletableFuture<JsonElement?>()
        synchronized(pending) { pending[id] = fut }
        writeLine(
            buildJsonObject {
                put("id", JsonPrimitive(id))
                put("method", JsonPrimitive(method))
                if (params != null) put("params", params)
            }.toString(),
        )
        return fut
    }

    fun start() {
        reader = thread(name = "stewart-rpc", isDaemon = true) { readLoop() }
    }

    fun close(reason: String = "closed") {
        if (closed) return
        closed = true
        val ps = synchronized(pending) { pending.values.toList().also { pending.clear() } }
        ps.forEach { it.completeExceptionally(IOException(reason)) }
        onClose?.invoke(reason)
    }

    private fun writeLine(line: String) {
        try {
            synchronized(writeLock) {
                output.write("$line\n".toByteArray(Charsets.UTF_8))
                output.flush()
            }
        } catch (e: IOException) {
            close("write failed: ${e.message}")
        }
    }

    private fun readLoop() {
        try {
            val sr = input.bufferedReader(Charsets.UTF_8)
            while (!closed) {
                val line = readLine(sr) ?: break
                if (line.isBlank()) continue
                dispatch(line)
            }
            close("stdin closed")
        } catch (e: LineTooLarge) {
            notify("protocol.error", JsonObject(mapOf("message" to JsonPrimitive("rpc line too large"))))
            close("rpc line too large")
        } catch (e: IOException) {
            close("read failed: ${e.message}")
        }
    }

    private class LineTooLarge : IOException()

    private fun readLine(sr: java.io.BufferedReader): String? {
        val sb = StringBuilder()
        var bytes = 0
        while (true) {
            val c = sr.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString()
            sb.append(c.toChar())
            if (++bytes > maxLineBytes) throw LineTooLarge()
        }
    }

    private fun dispatch(line: String) {
        val msg = try {
            json.parseToJsonElement(line) as? JsonObject ?: throw IOException("not an object")
        } catch (e: Exception) {
            notify("protocol.error", JsonObject(mapOf("message" to JsonPrimitive("malformed JSON line"))))
            return
        }
        val id = msg["id"]?.jsonPrimitive?.longOrNull
        val method = (msg["method"] as? JsonPrimitive)?.content
        if (id != null && method == null) {
            val p = synchronized(pending) { pending.remove(id) } ?: return
            val err = msg["error"] as? JsonObject
            if (err != null) p.completeExceptionally(IOException((err["message"] as? JsonPrimitive)?.content ?: "rpc error"))
            else p.complete(msg["result"])
            return
        }
        if (id != null && method != null) {
            val params = msg["params"]
            requestHandler(method, params).whenComplete { result, ex ->
                val resp = buildJsonObject {
                    put("id", JsonPrimitive(id))
                    if (ex != null) {
                        put("error", JsonObject(mapOf("message" to JsonPrimitive(ex.cause?.message ?: ex.message ?: "error"))))
                    } else {
                        put("result", result ?: kotlinx.serialization.json.JsonNull)
                    }
                }
                writeLine(resp.toString())
            }
            return
        }
        if (method != null) {
            val handlers = synchronized(notificationHandlers) { notificationHandlers.toList() }
            for (h in handlers) {
                try {
                    h(method, msg["params"])
                } catch (_: Exception) {
                    /* subscriber failure is isolated */
                }
            }
        }
    }
}

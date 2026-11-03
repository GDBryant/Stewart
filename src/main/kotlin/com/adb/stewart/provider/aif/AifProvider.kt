package com.adb.stewart.provider.aif

import com.adb.stewart.chat.redactImages
import com.adb.stewart.debug.DebugLogSink
import com.adb.stewart.http.IdeHttpClients
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolChoice
import com.adb.stewart.provider.Usage
import com.adb.stewart.settings.LegacyMigration
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private val json = Json { ignoreUnknownKeys = true }

object AifUrls {
    fun chatCompletions(base: String): String {
        val trimmed = base.trim().trimEnd('/')
        require(trimmed.startsWith("http://") || trimmed.startsWith("https://")) { "base URL must be http(s)" }
        val uri = URI(trimmed)
        require(uri.query == null && uri.fragment == null) { "base URL must not contain query/fragment" }
        return if (trimmed.endsWith("/chat/completions")) trimmed else "$trimmed/chat/completions"
    }

    fun models(base: String): String {
        val trimmed = base.trim().trimEnd('/')
        require(trimmed.startsWith("http://") || trimmed.startsWith("https://")) { "base URL must be http(s)" }
        val uri = URI(trimmed)
        require(uri.query == null && uri.fragment == null) { "base URL must not contain query/fragment" }
        return if (trimmed.endsWith("/models")) trimmed else "$trimmed/models"
    }
}

object AifCredentials {
    private val attributes = CredentialAttributes(generateServiceName("Stewart", "AIF API key"))
    private val legacyAttributes =
        CredentialAttributes(generateServiceName(LegacyMigration.CREDENTIAL_SUBSYSTEM, "AIF API key"))

    /** The legacy key is looked up once per session; `get()` runs on the debug-log redaction path. */
    @Volatile
    private var legacyChecked = false

    fun get(): String? {
        if (legacyChecked) return PasswordSafe.instance.get(attributes)?.getPasswordAsString()
        legacyChecked = true
        return LegacyMigration.migrateCredential(
            attributes, legacyAttributes, { PasswordSafe.instance.get(it) }, { a, c -> PasswordSafe.instance.set(a, c) },
        )?.getPasswordAsString()
    }

    /** Clearing also clears the legacy entry, or the next session would migrate it straight back. */
    fun set(key: String?) {
        legacyChecked = true
        PasswordSafe.instance.set(attributes, key?.let { Credentials("aif", it) })
        if (key == null) PasswordSafe.instance.set(legacyAttributes, null)
    }
}

class AifProvider(
    private val baseUrl: String,
    private val models: List<String>,
    private val apiKey: () -> String? = { AifCredentials.get() },
    private val client: HttpClient = IdeHttpClients.create(),
    private val nativeTools: (String) -> Boolean = { true },
) : ModelProvider {

    override val id: String = "aif"

    override fun supportsNativeTools(model: String): Boolean = nativeTools(model)

    override suspend fun listModels(): List<ModelInfo> = withContext(Dispatchers.IO) {
        val key = apiKey()
        if (key.isNullOrBlank()) return@withContext emptyList()
        val httpRequest = HttpRequest.newBuilder(URI.create(AifUrls.models(baseUrl)))
            .GET()
            .timeout(Duration.ofSeconds(10))
            .header("Authorization", "Bearer $key")
            .build()
        val response = client.send(httpRequest, HttpResponse.BodyHandlers.ofString())
        val body = response.body()
        if (response.statusCode() !in 200..299) {
            throw java.io.IOException(redact(extractError(body, "HTTP ${response.statusCode()}")))
        }
        val ids = try {
            val data = json.parseToJsonElement(body).jsonObject["data"]
                ?: throw java.io.IOException("malformed models response")
            data.jsonArray.mapNotNull { (it as? JsonObject)?.get("id")?.jsonPrimitive?.content }
        } catch (e: java.io.IOException) {
            throw e
        } catch (e: Exception) {
            throw java.io.IOException("malformed models response", e)
        }
        (ids + models).distinct().map { ModelInfo(ModelRef(id, it), it) }
    }

    override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
        val key = apiKey()
        if (key.isNullOrBlank()) {
            emit(ProviderEvent.Failed("AIF API key is not configured", code = "missing_api_key"))
            return@flow
        }
        val payload = buildJsonObject {
            put("model", request.model)
            put("stream", true)
            putJsonArray("messages") {
                AifHistory.sanitize(request.messages).forEach { msg -> add(messageJson(msg)) }
            }
            if (request.tools.isNotEmpty()) {
                putJsonArray("tools") {
                    request.tools.forEach { t ->
                        addJsonObject {
                            put("type", "function")
                            putJsonObject("function") {
                                put("name", t.name)
                                put("description", t.description)
                                put("parameters", t.parameters)
                            }
                        }
                    }
                }
                put("tool_choice", toolChoiceJson(request.toolChoice))
                request.parallelToolCalls?.let { put("parallel_tool_calls", it) }
            }
        }
        DebugLogSink.log(
            "outgoing", id, request.model,
            redactImages(payload.toString(), request.messages.flatMap { it.images }),
        )
        val httpRequest = HttpRequest.newBuilder(URI.create(AifUrls.chatCompletions(baseUrl)))
            .timeout(Duration.ofSeconds(60))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer $key")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
            .build()
        var stream: java.io.InputStream? = null
        var future: java.util.concurrent.CompletableFuture<HttpResponse<java.io.InputStream>>? = null
        try {
            val f = client.sendAsync(httpRequest, HttpResponse.BodyHandlers.ofInputStream())
            future = f
            currentCoroutineContext().job.invokeOnCompletion {
                f.cancel(true)
                runCatching { stream?.close() }
            }
            val response = f.join()
            stream = response.body()
            currentCoroutineContext().ensureActive()
            if (response.statusCode() !in 200..299) {
                val body = stream!!.bufferedReader().use { it.readText() }
                DebugLogSink.log("error", id, request.model, "HTTP ${response.statusCode()} $body")
                emit(ProviderEvent.Failed(redact(extractError(body, "HTTP ${response.statusCode()}")),
                    code = com.adb.stewart.provider.httpErrorCode(response.statusCode())))
                return@flow
            }
            var finish: String? = null
            var usage: Usage? = null
            val collector = com.adb.stewart.shim.NativeCallCollector()
            stream!!.bufferedReader().useLines { lines ->
                for (line in lines) {
                    currentCoroutineContext().ensureActive()
                    if (line.isBlank()) continue
                    if (DebugLogSink.isEnabled) {
                        DebugLogSink.log("incoming", id, request.model, line)
                    }
                    if (!line.startsWith("data:")) continue
                    val data = line.substring(5).trim()
                    if (data == "[DONE]") break
                    val obj = try {
                        json.parseToJsonElement(data)
                    } catch (e: Exception) {
                        emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                        return@flow
                    }
                    if (obj !is JsonObject) {
                        emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                        return@flow
                    }
                    obj["error"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.let {
                        emit(ProviderEvent.Failed(redact(extractError(data, "upstream error"))))
                        return@flow
                    }
                    val choices = obj["choices"]
                    if (obj["usage"] is JsonObject && (choices == null || choices is kotlinx.serialization.json.JsonNull || (choices as? JsonArray)?.isEmpty() == true)) {
                        val u = obj["usage"]!!.jsonObject
                        usage = Usage(
                            u["prompt_tokens"]?.jsonPrimitive?.intOrNull,
                            u["completion_tokens"]?.jsonPrimitive?.intOrNull,
                        )
                        continue
                    }
                    if (choices == null || choices is kotlinx.serialization.json.JsonNull) continue
                    if (choices !is JsonArray) {
                        emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                        return@flow
                    }
                    for (choice in choices) {
                        if (choice !is JsonObject) {
                            emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                            return@flow
                        }
                        val deltaEl = choice["delta"]
                        if (deltaEl != null && deltaEl !is JsonObject && deltaEl !is kotlinx.serialization.json.JsonNull) {
                            emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                            return@flow
                        }
                        val delta = deltaEl as? JsonObject ?: JsonObject(emptyMap())
                        val fr = choice["finish_reason"]
                        if (fr != null && fr !is kotlinx.serialization.json.JsonNull && (fr !is JsonPrimitive || !fr.isString || fr.content.isEmpty())) {
                            emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                            return@flow
                        }
                        val content = delta["content"]
                        if (content != null && content !is kotlinx.serialization.json.JsonNull && (content !is JsonPrimitive || !content.isString)) {
                            emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                            return@flow
                        }
                        val toolCalls = delta["tool_calls"]
                        if (toolCalls != null && toolCalls !is kotlinx.serialization.json.JsonNull && toolCalls !is JsonArray) {
                            emit(ProviderEvent.Failed("malformed SSE data", code = "invalid_upstream_response"))
                            return@flow
                        }
                        if (fr is JsonPrimitive && fr.isString) finish = fr.content
                        // JsonNull is a JsonPrimitive whose .content is "null"; only real strings are text.
                        (content as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }?.let {
                            emit(ProviderEvent.TextDelta(it))
                        }
                        (delta["reasoning_content"] as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() }?.let {
                            emit(ProviderEvent.ReasoningDelta(it.content))
                        }
                        if (toolCalls is JsonArray) collector.feed(toolCalls)
                    }
                }
            }
            if (finish == null) {
                DebugLogSink.log("error", id, request.model, "stream ended before completion")
                emit(ProviderEvent.Failed("stream ended before completion", code = "incomplete_stream"))
                return@flow
            }
            if (!collector.isEmpty()) emit(ProviderEvent.NativeToolCalls(collector.rawCalls()))
            emit(ProviderEvent.Completed(finish, usage))
        } catch (e: CancellationException) {
            throw e
        } catch (e: java.util.concurrent.CompletionException) {
            if (e.cause is CancellationException) throw CancellationException()
            DebugLogSink.log("error", id, request.model, e.cause?.message ?: "request failed")
            emit(ProviderEvent.Failed(redact(e.cause?.message ?: "request failed"), e.cause ?: e))
        } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            DebugLogSink.log("error", id, request.model, e.message ?: "request failed")
            emit(ProviderEvent.Failed(redact(e.message ?: "request failed"), e))
        } finally {
            runCatching { stream?.close() }
        }
    }.flowOn(Dispatchers.IO)

    private fun messageJson(msg: ChatMessage): JsonObject = buildJsonObject {
        put("role", when (msg.role) {
            Role.SYSTEM -> "system"
            Role.USER -> "user"
            Role.ASSISTANT -> "assistant"
            Role.TOOL -> "tool"
        })
        if (msg.images.isEmpty()) {
            put("content", msg.content)
        } else {
            putJsonArray("content") {
                if (msg.content.isNotBlank()) {
                    addJsonObject {
                        put("type", "text")
                        put("text", msg.content)
                    }
                }
                msg.images.forEach { img ->
                    addJsonObject {
                        put("type", "image_url")
                        putJsonObject("image_url") { put("url", img.dataUrl()) }
                    }
                }
            }
        }
        if (msg.toolCalls.isNotEmpty()) {
            putJsonArray("tool_calls") {
                msg.toolCalls.forEach { call ->
                    addJsonObject {
                        put("id", call.id)
                        put("type", "function")
                        putJsonObject("function") {
                            put("name", call.name)
                            put("arguments", call.arguments.toString())
                        }
                    }
                }
            }
        }
        msg.toolCallId?.let { put("tool_call_id", it) }
    }

    private fun toolChoiceJson(choice: ToolChoice): JsonElement = when (choice) {
        ToolChoice.Auto -> JsonPrimitive("auto")
        ToolChoice.None -> JsonPrimitive("none")
        ToolChoice.Required -> JsonPrimitive("required")
        is ToolChoice.Function -> buildJsonObject {
            put("type", "function")
            putJsonObject("function") { put("name", choice.name) }
        }
    }

    private fun redact(message: String): String =
        apiKey()?.takeIf { it.isNotBlank() }?.let { message.replace(it, "***") } ?: message

    private fun extractError(body: String, fallback: String): String = try {
        val el = json.parseToJsonElement(body)
        val err = (el as? JsonObject)?.get("error")
        when (err) {
            is JsonPrimitive -> err.content
            is JsonObject -> err["message"]?.jsonPrimitive?.content ?: fallback
            else -> fallback
        }
    } catch (e: Exception) {
        body.ifBlank { fallback }.take(500)
    }
}

/**
 * OpenAI-style APIs reject an assistant `tool_calls` block unless each call has a unique id answered
 * by exactly one following `tool` message. History from another provider (or an older store) may not
 * pair cleanly; such blocks, and orphan tool results, are degraded to plain text instead.
 */
object AifHistory {
    fun sanitize(messages: List<ChatMessage>): List<ChatMessage> {
        val out = mutableListOf<ChatMessage>()
        var i = 0
        while (i < messages.size) {
            val msg = messages[i]
            if (msg.role == Role.ASSISTANT && msg.toolCalls.isNotEmpty()) {
                var j = i + 1
                while (j < messages.size && messages[j].role == Role.TOOL) j++
                val results = messages.subList(i + 1, j)
                if (pairs(msg, results)) {
                    out.add(msg)
                    out.addAll(results)
                } else {
                    val names = msg.toolCalls.associate { it.id to it.name }
                    out.add(ChatMessage(Role.ASSISTANT, (listOf(msg.content) + msg.toolCalls.map {
                        "[called tool ${it.name} ${it.arguments}]"
                    }).filter { it.isNotBlank() }.joinToString("\n")))
                    results.forEach { out.add(asText(it, names[it.toolCallId])) }
                }
                i = j
                continue
            }
            out.add(if (msg.role == Role.TOOL) asText(msg, null) else msg)
            i++
        }
        return out
    }

    private fun pairs(call: ChatMessage, results: List<ChatMessage>): Boolean {
        val ids = call.toolCalls.map { it.id }
        if (ids.any { it.isBlank() } || ids.toSet().size != ids.size) return false
        val answered = results.map { it.toolCallId }
        return answered.size == ids.size && answered.toSet() == ids.toSet()
    }

    private fun asText(result: ChatMessage, name: String?): ChatMessage =
        ChatMessage(Role.USER, "[tool result ${name ?: "unknown"}] ${result.content}")
}

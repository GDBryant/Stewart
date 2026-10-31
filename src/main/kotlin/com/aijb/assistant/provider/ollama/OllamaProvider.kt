package com.aijb.assistant.provider.ollama

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private val json = Json { ignoreUnknownKeys = true }

class OllamaProvider(
    private val baseUrl: String = "http://localhost:11434",
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .proxy(HttpClient.Builder.NO_PROXY)
        .build(),
) : ModelProvider {

    override val id: String = "ollama"

    @Volatile private var capabilityCache: Map<String, Boolean> = emptyMap()

    override fun supportsNativeTools(model: String): Boolean = capabilityCache[model] ?: false

    override suspend fun listModels(): List<ModelInfo> = withContext(Dispatchers.IO) {
        val request = HttpRequest.newBuilder(URI.create("$baseUrl/api/tags"))
            .GET()
            .timeout(Duration.ofSeconds(10))
            .build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        val body = response.body()
        if (response.statusCode() !in 200..299) {
            throw java.io.IOException(OllamaNdjson.extractError(body, "HTTP ${response.statusCode()}"))
        }
        val root = json.parseToJsonElement(body).jsonObject
        val entries = root["models"]?.jsonArray.orEmpty().mapNotNull { element ->
            val obj = element as? JsonObject ?: return@mapNotNull null
            val name = obj["name"]?.jsonPrimitive?.content ?: return@mapNotNull null
            name to (obj["capabilities"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.content }
        }
        val semaphore = Semaphore(4)
        val resolved = coroutineScope {
            entries.map { (name, caps) ->
                async {
                    val capable = if (caps != null) {
                        "tools" in caps
                    } else {
                        semaphore.withPermit { probeToolsCapability(name) }
                    }
                    name to (capable ?: false)
                }
            }.awaitAll()
        }
        capabilityCache = resolved.toMap()
        entries.map { (name, _) -> ModelInfo(ModelRef(id, name), name) }
    }

    private suspend fun <T> await(future: java.util.concurrent.CompletableFuture<T>): T =
        kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            future.whenComplete { v, e ->
                if (e == null) cont.resume(v) { v }
                else cont.resumeWith(Result.failure(e))
            }
            cont.invokeOnCancellation { future.cancel(true) }
        }

    private suspend fun probeToolsCapability(model: String): Boolean? {
        try {
            val request = HttpRequest.newBuilder(URI.create("$baseUrl/api/show"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(JsonObject(mapOf("name" to JsonPrimitive(model))).toString()))
                .build()
            val response = await(client.sendAsync(request, HttpResponse.BodyHandlers.ofString()))
            if (response.statusCode() !in 200..299) return null
            val caps = json.parseToJsonElement(response.body()).jsonObject["capabilities"]?.jsonArray
                ?: return null
            return caps.any { it.jsonPrimitive.content == "tools" }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
    }

    override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
        val payload = JsonObject(buildJsonObject {
            put("model", request.model)
            put("stream", true)
            putJsonArray("messages") {
                val toolNameByCallId = mutableMapOf<String, String>()
                request.messages.forEach { msg ->
                    msg.toolCalls.forEach { toolNameByCallId[it.id] = it.name }
                    addJsonObject {
                        put("role", msg.role.name.lowercase())
                        put("content", msg.content)
                        if (msg.toolCalls.isNotEmpty()) {
                            putJsonArray("tool_calls") {
                                msg.toolCalls.forEach { call ->
                                    addJsonObject {
                                        put("id", call.id)
                                        put("type", "function")
                                        putJsonObject("function") {
                                            put("name", call.name)
                                            put("arguments", call.arguments)
                                        }
                                    }
                                }
                            }
                        }
                        msg.toolCallId?.let {
                            put("tool_call_id", it)
                            toolNameByCallId[it]?.let { n -> put("tool_name", n) }
                        }
                    }
                }
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
            }
        })
        val httpRequest = HttpRequest.newBuilder(URI.create("$baseUrl/api/chat"))
            .header("Content-Type", "application/json")
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
                val message = OllamaNdjson.extractError(body, "HTTP ${response.statusCode()}")
                val code = if (response.statusCode() == 400 &&
                    message.contains("does not support tools", ignoreCase = true)) {
                    "native_tools_unsupported"
                } else {
                    null
                }
                emit(ProviderEvent.Failed(message, code = code))
                return@flow
            }
            var sawDone = false
            val callIdPrefix = "call_${java.util.UUID.randomUUID().toString().replace("-", "")}-"
            var callSeq = 0
            val seenCallIds = mutableSetOf<String>()
            stream!!.bufferedReader().useLines { lines ->
                for (line in lines) {
                    currentCoroutineContext().ensureActive()
                    if (line.isBlank()) continue
                    for (event in OllamaNdjson.parseLineEvents(line) { _ -> callIdPrefix + callSeq++ }) {
                        if (event is ProviderEvent.NativeToolCalls) {
                            if (event.calls.any { it.id in seenCallIds }) {
                                emit(ProviderEvent.Failed(
                                    "duplicate tool call id in response",
                                    code = "invalid_upstream_response"))
                                return@flow
                            }
                            seenCallIds.addAll(event.calls.map { it.id!! })
                        }
                        if (event is ProviderEvent.Failed) {
                            emit(event)
                            return@flow
                        }
                        if (event is ProviderEvent.Completed) sawDone = true
                        emit(event)
                    }
                }
            }
            currentCoroutineContext().ensureActive()
            if (!sawDone) emit(ProviderEvent.Failed("stream ended before completion"))
        } catch (e: CancellationException) {
            throw e
        } catch (e: java.util.concurrent.CompletionException) {
            currentCoroutineContext().ensureActive(); if (e.cause is CancellationException) throw CancellationException()
            emit(ProviderEvent.Failed(e.cause?.message ?: "request failed", e.cause ?: e))
        } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            emit(ProviderEvent.Failed(e.message ?: "request failed", e))
        } finally {
            runCatching { stream?.close() }
        }
    }.flowOn(Dispatchers.IO)
}

object OllamaNdjson {
    fun parseLine(line: String): ProviderEvent? {
        val events = parseLineEvents(line)
        return events.filterIsInstance<ProviderEvent.Completed>().firstOrNull()
            ?: events.firstOrNull()
    }

    fun parseLineEvents(
        line: String,
        callIdForIndex: (Int) -> String = { "call_$it" },
    ): List<ProviderEvent> {
        val root = try {
            json.parseToJsonElement(line).jsonObject
        } catch (e: Exception) {
            return listOf(ProviderEvent.Failed("malformed response line: ${e.message}"))
        }
        return try {
            val error = root["error"]?.jsonPrimitive?.content
            if (error != null) {
                return listOf(ProviderEvent.Failed(error))
            }
            val messageEl = root["message"]
            if (messageEl != null && messageEl !is JsonObject) {
                return listOf(ProviderEvent.Failed("malformed response line: non-object message"))
            }
            val message = messageEl as? JsonObject
            val toolCalls = message?.get("tool_calls")
                ?.takeIf { it !is kotlinx.serialization.json.JsonNull }
            val done = if (root["done"]?.jsonPrimitive?.booleanOrNull == true) {
                ProviderEvent.Completed(
                    finishReason = root["done_reason"]?.jsonPrimitive?.content ?: "stop",
                    usage = Usage(
                        promptTokens = root["prompt_eval_count"]?.jsonPrimitive?.intOrNull,
                        completionTokens = root["eval_count"]?.jsonPrimitive?.intOrNull,
                    ),
                )
            } else {
                null
            }
            if (toolCalls != null && toolCalls !is kotlinx.serialization.json.JsonArray) {
                return listOf(ProviderEvent.Failed(
                    "malformed tool_calls in response", code = "invalid_upstream_response"))
            }
            val events = mutableListOf<ProviderEvent>()
            val parsed = if (toolCalls is kotlinx.serialization.json.JsonArray && toolCalls.isNotEmpty()) {
                parseToolCalls(toolCalls, callIdForIndex)
            } else {
                null
            }
            if (parsed is ProviderEvent.Failed) return listOf(parsed)
            val content = message?.get("content")?.jsonPrimitive?.content
            if (!content.isNullOrEmpty()) events.add(ProviderEvent.TextDelta(content))
            if (parsed != null) events.add(parsed)
            if (done != null) events.add(done)
            events
        } catch (e: Exception) {
            listOf(ProviderEvent.Failed("malformed response line: ${e.message}"))
        }
    }

    private fun parseToolCalls(
        toolCalls: kotlinx.serialization.json.JsonArray,
        callIdForIndex: (Int) -> String,
    ): ProviderEvent {
        val calls = toolCalls.mapIndexed { i, el ->
            val fn = (el as? JsonObject)?.get("function") as? JsonObject
                ?: return ProviderEvent.Failed("malformed tool_calls in response", code = "invalid_upstream_response")
            val nameEl = fn["name"] as? JsonPrimitive
            val name = nameEl?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
                ?: return ProviderEvent.Failed("malformed tool_calls in response", code = "invalid_upstream_response")
            val args = fn["arguments"]
            val argString = when (args) {
                null, kotlinx.serialization.json.JsonNull -> "{}"
                is JsonObject -> args.toString()
                is JsonPrimitive -> if (args.isString) {
                    args.content
                } else {
                    return ProviderEvent.Failed("malformed tool_calls in response", code = "invalid_upstream_response")
                }
                else -> return ProviderEvent.Failed("malformed tool_calls in response", code = "invalid_upstream_response")
            }
            val idEl = (el as JsonObject)["id"] as? JsonPrimitive
            val id = idEl?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
                ?: callIdForIndex(i)
            com.aijb.assistant.provider.RawToolCall(id, name, argString)
        }
        if (calls.map { it.id }.toSet().size != calls.size) {
            return ProviderEvent.Failed(
                "duplicate tool call id in response", code = "invalid_upstream_response")
        }
        return ProviderEvent.NativeToolCalls(calls)
    }

    fun extractError(body: String, fallback: String): String = try {
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content ?: fallback
    } catch (e: Exception) {
        body.ifBlank { fallback }
    }
}

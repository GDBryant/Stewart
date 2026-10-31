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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

private val json = Json { ignoreUnknownKeys = true }

class OllamaProvider(private val baseUrl: String = "http://localhost:11434") : ModelProvider {

    override val id: String = "ollama"

    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .proxy(HttpClient.Builder.NO_PROXY)
        .build()

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
        root["models"]?.jsonArray.orEmpty().mapNotNull { element ->
            element.jsonObject["name"]?.jsonPrimitive?.content
        }.map { name ->
            ModelInfo(ModelRef(id, name), name)
        }
    }

    override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
        val payload = JsonObject(buildJsonObject {
            put("model", request.model)
            put("stream", true)
            putJsonArray("messages") {
                request.messages.forEach { msg ->
                    addJsonObject {
                        put("role", msg.role.name.lowercase())
                        put("content", msg.content)
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
                emit(ProviderEvent.Failed(OllamaNdjson.extractError(body, "HTTP ${response.statusCode()}")))
                return@flow
            }
            var sawDone = false
            stream!!.bufferedReader().useLines { lines ->
                for (line in lines) {
                    currentCoroutineContext().ensureActive()
                    if (line.isBlank()) continue
                    val event = OllamaNdjson.parseLine(line)
                    if (event is ProviderEvent.Failed) {
                        emit(event)
                        return@flow
                    }
                    if (event is ProviderEvent.Completed) sawDone = true
                    if (event != null) emit(event)
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
    fun parseLine(line: String): ProviderEvent? = try {
        val root = json.parseToJsonElement(line).jsonObject
        val error = root["error"]?.jsonPrimitive?.content
        when {
            error != null -> ProviderEvent.Failed(error)
            root["done"]?.jsonPrimitive?.booleanOrNull == true ->
                ProviderEvent.Completed(
                    finishReason = root["done_reason"]?.jsonPrimitive?.content,
                    usage = Usage(
                        promptTokens = root["prompt_eval_count"]?.jsonPrimitive?.intOrNull,
                        completionTokens = root["eval_count"]?.jsonPrimitive?.intOrNull,
                    ),
                )
            else -> {
                val content = root["message"]?.jsonObject?.get("content")?.jsonPrimitive?.content
                if (content.isNullOrEmpty()) null else ProviderEvent.TextDelta(content)
            }
        }
    } catch (e: Exception) {
        ProviderEvent.Failed("malformed response line: ${e.message}")
    }

    fun extractError(body: String, fallback: String): String = try {
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content ?: fallback
    } catch (e: Exception) {
        body.ifBlank { fallback }
    }
}

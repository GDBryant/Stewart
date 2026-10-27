package com.aijb.assistant.provider.claude

import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Usage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal class ClaudeStreamParser {

    private val json = Json { ignoreUnknownKeys = true }

    val deltaMessageIds = mutableSetOf<String>()
    var stopReason: String? = null
    var resultSeen = false
    var resultIsError = false
    var resultFailed = false
    var usage: Usage? = null
    var finishReason: String? = null
    var failedEmitted = false

    private fun failed(message: String, code: String): ProviderEvent.Failed {
        failedEmitted = true
        return ProviderEvent.Failed(message, code = code)
    }

    private fun classify(message: String): String = when {
        Regex("(?i)not logged in|log ?in|authenticat|oauth|unauthori[sz]ed|\\b401\\b|token.*expired").containsMatchIn(message) -> "auth"
        Regex("(?i)issue with the selected model").containsMatchIn(message) -> "model_unavailable"
        Regex("(?i)rate limit|\\b429\\b|usage limit").containsMatchIn(message) -> "rate_limited"
        else -> "cli_error"
    }

    fun classifyStderr(message: String): String = classify(message)

    fun mapStopReason(raw: String?): String? = when (raw) {
        "end_turn", "stop_sequence" -> "stop"
        "max_tokens" -> "length"
        "refusal" -> "content_filter"
        else -> raw
    }

    fun feed(line: String): List<ProviderEvent> {
        if (resultSeen) return emptyList()
        val obj = try {
            json.parseToJsonElement(line)
        } catch (e: Exception) {
            return emptyList()
        }
        if (obj !is JsonObject) return emptyList()
        return when (obj["type"]?.jsonPrimitive?.content) {
            "system" -> systemEvent(obj)
            "stream_event" -> streamEvent(obj)
            "assistant" -> assistantEvent(obj)
            "user" -> userEvent(obj)
            "result" -> resultEvent(obj)
            else -> emptyList()
        }
    }

    private fun nonemptyArray(el: kotlinx.serialization.json.JsonElement?) =
        (el as? JsonArray)?.isNotEmpty() == true

    private fun systemEvent(obj: JsonObject): List<ProviderEvent> {
        if (obj["subtype"]?.jsonPrimitive?.content != "init") return emptyList()
        if (nonemptyArray(obj["tools"]) || nonemptyArray(obj["mcp_servers"])) {
            return listOf(failed("CLI advertised tools or MCP servers", "isolation_violation"))
        }
        return emptyList()
    }

    private fun streamEvent(obj: JsonObject): List<ProviderEvent> {
        val event = obj["event"] as? JsonObject ?: return emptyList()
        return when (event["type"]?.jsonPrimitive?.content) {
            "content_block_delta" -> {
                val delta = event["delta"] as? JsonObject ?: return emptyList()
                when (delta["type"]?.jsonPrimitive?.content) {
                    "text_delta" -> {
                        eventMessageId(obj)?.let { deltaMessageIds.add(it) }
                        delta["text"]?.jsonPrimitive?.content?.let { listOf(ProviderEvent.TextDelta(it)) } ?: emptyList()
                    }
                    "thinking_delta" ->
                        delta["thinking"]?.jsonPrimitive?.content?.let { listOf(ProviderEvent.ReasoningDelta(it)) } ?: emptyList()
                    else -> emptyList()
                }
            }
            "content_block_start" -> {
                val block = event["content_block"] as? JsonObject
                when (block?.get("type")?.jsonPrimitive?.content) {
                    "server_tool_use" ->
                        if (block["name"]?.jsonPrimitive?.content == "advisor") emptyList()
                        else listOf(failed("CLI invoked a server tool", "isolation_violation"))
                    else -> emptyList()
                }
            }
            "message_delta" -> {
                (event["delta"] as? JsonObject)?.get("stop_reason")?.jsonPrimitive?.content?.let {
                    stopReason = it
                }
                emptyList()
            }
            else -> emptyList()
        }
    }

    private fun eventMessageId(obj: JsonObject): String? =
        (obj["event"] as? JsonObject)?.get("message")?.jsonObject?.get("id")?.jsonPrimitive?.content
            ?: obj["api_message_id"]?.jsonPrimitive?.content

    private fun assistantEvent(obj: JsonObject): List<ProviderEvent> {
        val message = obj["message"] as? JsonObject ?: return emptyList()
        val out = mutableListOf<ProviderEvent>()
        for (block in (message["content"] as? JsonArray) ?: return emptyList()) {
            val b = block as? JsonObject ?: continue
            when (b["type"]?.jsonPrimitive?.content) {
                "server_tool_use" ->
                    if (b["name"]?.jsonPrimitive?.content != "advisor") {
                        return listOf(failed("CLI invoked a server tool", "isolation_violation"))
                    }
            }
        }
        val id = message["id"]?.jsonPrimitive?.content
        if (id != null && id in deltaMessageIds) return emptyList()
        for (block in (message["content"] as? JsonArray) ?: emptyList()) {
            val b = block as? JsonObject ?: continue
            when (b["type"]?.jsonPrimitive?.content) {
                "text" -> b["text"]?.jsonPrimitive?.content?.let { out.add(ProviderEvent.TextDelta(it)) }
                "thinking" -> b["thinking"]?.jsonPrimitive?.content?.let { out.add(ProviderEvent.ReasoningDelta(it)) }
            }
        }
        return out
    }

    private fun userEvent(obj: JsonObject): List<ProviderEvent> {
        val content = (obj["message"] as? JsonObject)?.get("content")
        for (block in (content as? JsonArray) ?: return emptyList()) {
            val b = block as? JsonObject ?: continue
            if (b["type"]?.jsonPrimitive?.content == "tool_result" &&
                b["is_error"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() != true
            ) {
                return listOf(failed("CLI executed a tool", "isolation_violation"))
            }
        }
        return emptyList()
    }

    private fun resultEvent(obj: JsonObject): List<ProviderEvent> {
        resultSeen = true
        if (obj["is_error"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() == true) {
            resultIsError = true
            resultFailed = true
            val message = obj["result"]?.jsonPrimitive?.content ?: "Claude CLI error"
            return listOf(failed(message, classify(message)))
        }
        val fr = mapStopReason(stopReason ?: obj["stop_reason"]?.jsonPrimitive?.content)
        finishReason = fr
        val u = obj["usage"] as? JsonObject
        usage = u?.let {
            Usage(
                (it["input_tokens"]?.jsonPrimitive?.intOrNull ?: 0) +
                    (it["cache_creation_input_tokens"]?.jsonPrimitive?.intOrNull ?: 0) +
                    (it["cache_read_input_tokens"]?.jsonPrimitive?.intOrNull ?: 0),
                it["output_tokens"]?.jsonPrimitive?.intOrNull,
            )
        }
        return emptyList()
    }
}

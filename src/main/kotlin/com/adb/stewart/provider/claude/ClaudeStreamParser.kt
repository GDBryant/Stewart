package com.adb.stewart.provider.claude

import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Usage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
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
    /** The CLI's tool turn is over: stop reading and complete with `tool_calls`. */
    var toolTurnEnded = false
    /** The CLI rejected a surfaced tool_use; more tool_use blocks of the same message may still follow. */
    var cutPending = false
    val nativeCalls = mutableListOf<RawToolCall>()
    private var emittedNativeCalls = 0
    private val seenToolUseIds = mutableSetOf<String>()
    private var toolMessageId: String? = null
    /** Per-message stream usage: [input incl. cache, output]; repeated events for one id keep the max. */
    private val streamUsage = linkedMapOf<String, Array<Int?>>()

    /** `result` usage when present, else the sum over the turn's messages (each API call bills separately). */
    fun turnUsage(): Usage? {
        usage?.let { return it }
        if (streamUsage.isEmpty()) return null
        fun sum(i: Int) = streamUsage.values.mapNotNull { it[i] }.takeIf { it.isNotEmpty() }?.sum()
        return Usage(sum(0), sum(1))
    }

    private fun recordUsage(obj: JsonObject) {
        val (id, u) = when (obj["type"]?.jsonPrimitive?.content) {
            "assistant" -> (obj["message"] as? JsonObject).let { m ->
                m?.get("id")?.jsonPrimitive?.content to m?.get("usage")
            }
            "stream_event" -> {
                val event = obj["event"] as? JsonObject ?: return
                when (event["type"]?.jsonPrimitive?.content) {
                    "message_start" -> eventMessageId(obj) to (event["message"] as? JsonObject)?.get("usage")
                    "message_delta" -> eventMessageId(obj) to event["usage"]
                    else -> return
                }
            }
            else -> return
        }
        val o = u as? JsonObject ?: return
        if (cutPending && id != toolMessageId) return
        fun int(k: String) = (o[k] as? JsonPrimitive)?.intOrNull
        val parts = listOf("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens").mapNotNull { int(it) }
        val slot = streamUsage.getOrPut(id ?: "") { arrayOf(null, null) }
        // Counts are cumulative per message; max ignores stale snapshots in repeated assistant events.
        if (parts.isNotEmpty()) slot[0] = maxOf(slot[0] ?: 0, parts.sum())
        int("output_tokens")?.let { slot[1] = maxOf(slot[1] ?: 0, it) }
    }

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
        if (resultSeen || toolTurnEnded) return emptyList()
        val obj = try {
            json.parseToJsonElement(line)
        } catch (e: Exception) {
            return emptyList()
        }
        if (obj !is JsonObject) return emptyList()
        recordUsage(obj)
        if (cutPending && endsToolTurn(obj)) {
            toolTurnEnded = true
            finishReason = "tool_calls"
            return emptyList()
        }
        return when (obj["type"]?.jsonPrimitive?.content) {
            "system" -> systemEvent(obj)
            "stream_event" -> streamEvent(obj)
            "assistant" -> assistantEvent(obj)
            "user" -> userEvent(obj)
            "result" -> resultEvent(obj)
            else -> emptyList()
        }
    }

    /** After a rejected tool_use: the tool message is over once it stops or another message begins. */
    private fun endsToolTurn(obj: JsonObject): Boolean {
        return when (obj["type"]?.jsonPrimitive?.content) {
            "assistant" -> (obj["message"] as? JsonObject)?.get("id")?.jsonPrimitive?.content != toolMessageId
            "stream_event" -> when ((obj["event"] as? JsonObject)?.get("type")?.jsonPrimitive?.content) {
                "message_start", "message_delta", "message_stop" -> true
                else -> eventMessageId(obj).let { it != null && it != toolMessageId }
            }
            else -> false
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
                    "thinking_delta" -> {
                        eventMessageId(obj)?.let { deltaMessageIds.add(it) }
                        delta["thinking"]?.jsonPrimitive?.content?.let { listOf(ProviderEvent.ReasoningDelta(it)) } ?: emptyList()
                    }
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
        val blocks = (message["content"] as? JsonArray) ?: return emptyList()
        for (block in blocks) {
            val b = block as? JsonObject ?: continue
            when (b["type"]?.jsonPrimitive?.content) {
                "server_tool_use" ->
                    if (b["name"]?.jsonPrimitive?.content != "advisor") {
                        return listOf(failed("CLI invoked a server tool", "isolation_violation"))
                    }
                "tool_use" -> {
                    val name = b["name"]?.jsonPrimitive?.content
                    val callId = b["id"]?.jsonPrimitive?.content
                    if (!name.isNullOrBlank() && (callId == null || seenToolUseIds.add(callId))) {
                        toolMessageId = message["id"]?.jsonPrimitive?.content
                        nativeCalls += RawToolCall(
                            callId,
                            name,
                            (b["input"] as? JsonObject)?.toString() ?: "{}",
                        )
                    }
                }
            }
        }
        val id = message["id"]?.jsonPrimitive?.content
        if (id == null || id !in deltaMessageIds) {
            for (block in blocks) {
                val b = block as? JsonObject ?: continue
                when (b["type"]?.jsonPrimitive?.content) {
                    "text" -> b["text"]?.jsonPrimitive?.content?.let { out.add(ProviderEvent.TextDelta(it)) }
                    "thinking" -> b["thinking"]?.jsonPrimitive?.content?.let { out.add(ProviderEvent.ReasoningDelta(it)) }
                }
            }
        }
        if (nativeCalls.size > emittedNativeCalls) {
            out.add(ProviderEvent.NativeToolCalls(nativeCalls.drop(emittedNativeCalls)))
            emittedNativeCalls = nativeCalls.size
        }
        return out
    }

    private fun userEvent(obj: JsonObject): List<ProviderEvent> {
        val content = (obj["message"] as? JsonObject)?.get("content")
        var hasToolResult = false
        for (block in (content as? JsonArray) ?: return emptyList()) {
            val b = block as? JsonObject ?: continue
            if (b["type"]?.jsonPrimitive?.content == "tool_result") {
                if (b["is_error"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() != true) {
                    return listOf(failed("CLI executed a tool", "isolation_violation"))
                }
                hasToolResult = true
            }
        }
        if (hasToolResult && nativeCalls.isNotEmpty()) {
            cutPending = true
            finishReason = "tool_calls"
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
        finishReason = if (nativeCalls.isNotEmpty()) "tool_calls" else fr
        val u = obj["usage"] as? JsonObject
        usage = u?.let {
            Usage(
                (it["input_tokens"]?.jsonPrimitive?.intOrNull ?: 0) +
                    (it["cache_creation_input_tokens"]?.jsonPrimitive?.intOrNull ?: 0) +
                    (it["cache_read_input_tokens"]?.jsonPrimitive?.intOrNull ?: 0),
                it["output_tokens"]?.jsonPrimitive?.intOrNull,
                obj["total_cost_usd"]?.jsonPrimitive?.doubleOrNull,
            )
        }
        return emptyList()
    }
}

package com.adb.stewart.shim

import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.ToolCall
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

private val TAG_PREFIXES = listOf("<tool_call", "<call>", "<function=", "<think")
private val FENCE_RE = Regex("```")

private fun earliestTagStart(held: String): Int? {
    var best: Int? = null
    for (i in held.indices) {
        if (held[i] != '<') continue
        val tail = held.substring(i)
        for (tag in TAG_PREFIXES) {
            if (tail.startsWith(tag) || tag.startsWith(tail)) {
                if (best == null || i < best) best = i
                break
            }
        }
    }
    return best
}

class StreamTranslator(private val schema: Map<String, JsonObject>) {
    var held = ""
    private var holding = false
    private var emittedFenceCount = 0

    fun feed(text: String): String {
        if (text.isEmpty()) return ""
        held += text
        if (holding) return ""
        val i = earliestTagStart(held)
        if (i == null) {
            val emit = held
            held = ""
            emittedFenceCount += FENCE_RE.findAll(emit).count()
            return emit
        }
        val emit = held.substring(0, i)
        held = held.substring(i)
        if (TAG_PREFIXES.any { held.startsWith(it) }) {
            if (!TAG_PREFIXES.any { it.startsWith(held) }) {
                holding = true
            }
        }
        emittedFenceCount += FENCE_RE.findAll(emit).count()
        return emit
    }

    fun finish(finishReason: String?): ParseResult {
        if (finishReason == "length" || finishReason == "content_filter") {
            val out = held
            held = ""
            return ParseResult(out, emptyList(), null)
        }
        val result = ToolCallParser.parseToolCalls(held, schema, startInFence = emittedFenceCount % 2 == 1)
        held = ""
        return result
    }
}

/** String content of a primitive; JSON `null` (itself a `JsonPrimitive`) counts as absent. */
private fun JsonElement?.contentOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

class NativeCallCollector {
    private data class Slot(var id: String?, var name: String, var arguments: String)

    private val calls = sortedMapOf<Int, Slot>()

    fun feed(deltas: JsonElement?) {
        if (deltas == null) return
        if (deltas !is JsonArray) throw ToolCallParseException("TC-NATIVE-INVALID")
        for (delta in deltas) {
            if (delta !is JsonObject) throw ToolCallParseException("TC-NATIVE-INVALID")
            val indexEl = delta["index"]
            val index = when (indexEl) {
                null, is JsonNull -> 0
                is JsonPrimitive -> indexEl.intOrNull ?: throw ToolCallParseException("TC-NATIVE-INVALID")
                else -> throw ToolCallParseException("TC-NATIVE-INVALID")
            }
            if (index < 0) throw ToolCallParseException("TC-NATIVE-INVALID")
            val type = delta["type"].contentOrNull() ?: "function"
            if (type != "function") throw ToolCallParseException("TC-NATIVE-INVALID")
            val fn = delta["function"]
            if (fn != null && fn !is JsonObject && fn !is JsonNull) {
                throw ToolCallParseException("TC-NATIVE-INVALID")
            }
            val fnObj = fn as? JsonObject ?: JsonObject(emptyMap())
            val namePart = fnObj["name"]
            val argsPart = fnObj["arguments"]
            if (namePart != null && namePart !is JsonNull &&
                (namePart !is JsonPrimitive || !namePart.isString)) {
                throw ToolCallParseException("TC-NATIVE-INVALID")
            }
            if (argsPart != null && argsPart !is JsonNull &&
                (argsPart !is JsonPrimitive || !argsPart.isString)) {
                throw ToolCallParseException("TC-NATIVE-INVALID")
            }
            val slot = calls.getOrPut(index) { Slot(null, "", "") }
            delta["id"].contentOrNull()?.takeIf { it.isNotEmpty() }?.let { slot.id = it }
            slot.name += namePart.contentOrNull() ?: ""
            slot.arguments += argsPart.contentOrNull() ?: ""
        }
    }

    fun isEmpty(): Boolean = calls.isEmpty()

    fun rawCalls(): List<RawToolCall> =
        calls.entries.sortedBy { it.key }.map { RawToolCall(it.value.id, it.value.name, it.value.arguments) }

    fun finish(schema: Map<String, JsonObject>): List<ToolCall> {
        val out = mutableListOf<ToolCall>()
        for ((_, slot) in calls) {
            out.addAll(ToolCallParser.repairNativeCall(RawToolCall(slot.id, slot.name, slot.arguments), schema))
        }
        calls.clear()
        return out
    }
}

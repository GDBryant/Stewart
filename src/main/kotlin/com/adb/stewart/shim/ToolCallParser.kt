package com.adb.stewart.shim

import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.ToolCall
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

val FAILURE_REASONS = mapOf(
    "TC-JSON-NO-OBJECT" to "block contains no '{' so there is no JSON to read",
    "TC-JSON-INVALID" to "JSON could not be decoded, even after repair",
    "TC-JSON-NOT-OBJECT" to "JSON decoded but is not an object (expected {...})",
    "TC-NAME-MISSING" to "no tool name found (no name/function key and no name before the '{')",
    "TC-GLM-NO-NAME" to "GLM-style block has no tool name before the first <arg_key>",
    "TC-FUNC-NO-HEADER" to "<function=NAME> header is missing or malformed",
    "TC-ARGS-INVALID" to "arguments must be a JSON object",
    "TC-NATIVE-INVALID" to "native call must name an offered function with valid arguments",
)

class ToolCallParseException(val code: String, val detail: String = "") : Exception(code)

data class ParseResult(
    val clean: String,
    val calls: List<ToolCall>,
    val reasoning: String?,
)

private val json = Json { ignoreUnknownKeys = true }
private val TAG_RE = Regex("<tool_call>|<call>|<function=[^>]*>")
private val CLOSERS = mapOf("<tool_call>" to "</tool_call>", "<call>" to "</call>")
private val PREFIX_NAME_RE = Regex("[A-Za-z_][\\w.\\-:]*")
private val BARE_LITERAL_RE = Regex("true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")
private val FENCE_RE = Regex("```")

object ToolCallParser {

    private val NUMBER_RE = Regex("""-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?""")

    private fun checkStrict(el: JsonElement) {
        when (el) {
            is JsonPrimitive -> {
                if (!el.isString && el.booleanOrNull == null &&
                    !(el is JsonNull) && !NUMBER_RE.matches(el.content)
                ) throw IllegalArgumentException("non-JSON literal ${el.content}")
            }
            is JsonObject -> el.values.forEach { checkStrict(it) }
            is JsonArray -> el.forEach { checkStrict(it) }
        }
    }

    private fun strictDecode(text: String): JsonElement {
        val el = json.parseToJsonElement(text)
        checkStrict(el)
        return el
    }

    fun parseToolCalls(
        text: String,
        schema: Map<String, JsonObject>,
        startInFence: Boolean = false,
    ): ParseResult {
        val (stripped, reasoning) = stripThink(text)
        val calls = mutableListOf<ToolCall>()
        val cleanParts = mutableListOf<String>()
        var pos = 0
        var fenceCount = if (startInFence) 1 else 0
        while (true) {
            val m = TAG_RE.find(stripped, pos) ?: run {
                val tail = stripped.substring(pos)
                fenceCount += FENCE_RE.findAll(tail).count()
                cleanParts.add(tail)
                break
            }
            val before = stripped.substring(pos, m.range.first)
            fenceCount += FENCE_RE.findAll(before).count()
            cleanParts.add(before)
            val fenced = fenceCount % 2 == 1 || (m.range.first > 0 && stripped[m.range.first - 1] == '`')
            if (fenced) {
                cleanParts.add(m.value)
                pos = m.range.last + 1
                continue
            }
            val (raw, end) = findBlockEnd(stripped, m)
            val inner = if (m.value in CLOSERS) innermostToolCall(raw, m.value) else raw
            val parsed = readCall(inner, schema)
            if (parsed == null || parsed.first !in schema) {
                cleanParts.add(stripped.substring(m.range.first, end))
            } else {
                calls.add(makeCall(parsed.first, parsed.second))
            }
            pos = end
        }
        return ParseResult(cleanParts.joinToString("").trim(), calls, reasoning)
    }

    fun repairNativeCall(raw: RawToolCall, schema: Map<String, JsonObject>): List<ToolCall> {
        val name = raw.name
        val arguments = raw.arguments
        if (name.isBlank()) throw ToolCallParseException("TC-NATIVE-INVALID")
        if (name in schema) {
            val args = try {
                strictDecode(arguments)
            } catch (e: Exception) {
                throw ToolCallParseException("TC-ARGS-INVALID")
            }
            if (args !is JsonObject) throw ToolCallParseException("TC-ARGS-INVALID")
            return listOf(ToolCall(raw.id ?: newCallId(), name, args))
        }
        val trimmedArgs = arguments.trim()
        val text = name + if (trimmedArgs != "" && trimmedArgs != "{}" && "{" !in name) trimmedArgs else ""
        if ("{" !in text && "<" !in text) throw ToolCallParseException("TC-NATIVE-INVALID")
        val repaired = mutableListOf<ToolCall>()
        for (piece in text.replace("</tool_call>", "").split("<tool_call>")) {
            if (piece.isBlank()) continue
            val parsed = readCall(piece, schema)
            if (parsed == null || parsed.first !in schema) throw ToolCallParseException("TC-NATIVE-INVALID")
            repaired.add(makeCall(parsed.first, parsed.second))
        }
        if (repaired.isEmpty()) throw ToolCallParseException("TC-NATIVE-INVALID")
        return repaired
    }

    internal fun newCallId(): String = "call_" + UUID.randomUUID().toString().replace("-", "").take(24)

    private fun makeCall(name: String, args: JsonObject) = ToolCall(newCallId(), name, args)

    private fun stripThink(text: String): Pair<String, String?> {
        val reasoning = mutableListOf<String>()
        val out = StringBuilder()
        var i = 0
        while (true) {
            val start = text.indexOf("<think>", i)
            if (start == -1) {
                out.append(text.substring(i))
                break
            }
            out.append(text.substring(i, start))
            val end = text.indexOf("</think>", start)
            if (end == -1) {
                reasoning.add(text.substring(start + "<think>".length))
                break
            }
            reasoning.add(text.substring(start + "<think>".length, end))
            i = end + "</think>".length
        }
        val r = reasoning.filter { it.isNotBlank() }.joinToString("\n") { it.trim() }
        return out.toString() to r.ifEmpty { null }
    }

    private fun toolProperties(schema: Map<String, JsonObject>, name: String): JsonObject =
        (schema[name]?.get("properties") as? JsonObject) ?: JsonObject(emptyMap())

    private fun coerce(value: String, schemaProps: JsonObject, key: String): JsonElement {
        val ptype = (schemaProps[key] as? JsonObject)?.get("type")?.jsonPrimitive?.content
        return when (ptype) {
            "integer", "number", "array", "object" ->
                try {
                    strictDecode(value)
                } catch (e: Exception) {
                    JsonPrimitive(value)
                }
            "boolean" -> when (value.trim().lowercase()) {
                "true" -> JsonPrimitive(true)
                "false" -> JsonPrimitive(false)
                else -> JsonPrimitive(value)
            }
            else -> JsonPrimitive(value)
        }
    }

    private fun skipWhitespace(s: String, k0: Int): Int {
        var k = k0
        while (k < s.length && s[k] in " \t\r\n") k++
        return k
    }

    private fun closesString(s: String, j: Int): Boolean {
        var k = skipWhitespace(s, j + 1)
        if (k >= s.length) return true
        if (s[k] in ":}]") return true
        if (s[k] != ',') return false
        k = skipWhitespace(s, k + 1)
        return k >= s.length || s[k] in "\"{[-0123456789tfn"
    }

    private val BARE_TOKEN_RE = Regex("[^,}\\]\\n]*")

    private fun quoteBareValue(s: String, i0: Int): Pair<String, Int> {
        val start = i0
        var i = skipWhitespace(s, i0)
        var emitted = s.substring(start, i)
        if (i < s.length && s[i] !in "\"{[") {
            val token = (BARE_TOKEN_RE.find(s, i)?.value ?: "").trimEnd()
            if (token.isNotEmpty() && !BARE_LITERAL_RE.matches(token)) {
                emitted += JsonPrimitive(token).toString()
                i += token.length
            }
        }
        return emitted to i
    }

    private fun repairJson(s: String): String {
        val out = StringBuilder()
        val stack = ArrayDeque<Char>()
        var inStr = false
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (inStr) {
                if (c == '\\' && i + 1 < s.length) {
                    out.append(s.substring(i, i + 2))
                    i += 2
                    continue
                }
                if (c == '"') {
                    if (closesString(s, i)) {
                        inStr = false
                    } else {
                        out.append("\\\"")
                        i += 1
                        continue
                    }
                }
            } else if (c == '"') {
                inStr = true
            } else if (c == ':') {
                out.append(c)
                val (emitted, ni) = quoteBareValue(s, i + 1)
                out.append(emitted)
                i = ni
                continue
            } else if (c in "{[") {
                stack.addLast(if (c == '{') '}' else ']')
            } else if (c in "}]" && stack.isNotEmpty()) {
                stack.removeLast()
            }
            out.append(c)
            i += 1
        }
        val repaired = out.toString().trimEnd()
        return repaired + stack.toList().reversed().joinToString("")
    }

    private val CLEAN_FENCE_RE = Regex("```(?:json)?\\s*")
    private val CLEAN_FUNCNAME_RE = Regex("^<\\s*function[\\s_]*name\\s*=\\s*(?=\")")
    private val CLEAN_FIRSTKEY_RE = Regex("^(\\{\\s*)\"(?:function_name|function|name)\\s*=\\s*\"?([\\w.-]+)>?\"")

    private fun cleanJsonBlock(raw0: String): String {
        var raw = raw0.trim()
        val m = CLEAN_FENCE_RE.find(raw)
        if (m != null) {
            raw = raw.substring(m.range.last + 1).split("```", limit = 2)[0]
        }
        raw = CLEAN_FUNCNAME_RE.replace(raw, "{\"name\": ")
        return CLEAN_FIRSTKEY_RE.replace(raw) { m -> m.groupValues[1] + "\"name\": \"" + m.groupValues[2] + "\"" }
    }

    private fun firstJsonValueEnd(s: String): Int {
        var i = skipWhitespace(s, 0)
        if (i >= s.length) return -1
        val open = s[i]
        if (open == '"') {
            var j = i + 1
            while (j < s.length) {
                if (s[j] == '\\') j += 2 else if (s[j] == '"') return j + 1 else j++
            }
            return -1
        }
        if (open == '{' || open == '[') {
            val stack = ArrayDeque<Char>()
            stack.addLast(if (open == '{') '}' else ']')
            var j = i + 1
            var inStr = false
            while (j < s.length && stack.isNotEmpty()) {
                val c = s[j]
                if (inStr) {
                    if (c == '\\') j++ else if (c == '"') inStr = false
                } else if (c == '"') inStr = true
                else if (c == '{' || c == '[') stack.addLast(if (c == '{') '}' else ']')
                else if (c == '}' || c == ']') {
                    if (stack.last() == c) stack.removeLast()
                }
                j++
            }
            return if (stack.isEmpty()) j else -1
        }
        val m = Regex("[^,\\s}\\]]*").find(s, i) ?: return -1
        return if (m.value.isEmpty()) -1 else m.range.last + 1
    }

    private fun decodeJsonObject(text: String): Pair<JsonObject, String> {
        val idx = text.indexOf('{')
        if (idx == -1) throw ToolCallParseException("TC-JSON-NO-OBJECT")
        val body = text.substring(idx)
        var obj: JsonElement? = try {
            val end = firstJsonValueEnd(body)
            if (end == -1) throw IllegalArgumentException()
            strictDecode(body.substring(0, end))
        } catch (e: Exception) {
            null
        }
        if (obj == null) {
            try {
                val repaired = repairJson(body)
                val end = firstJsonValueEnd(repaired)
                if (end == -1) throw IllegalArgumentException()
                obj = strictDecode(repaired.substring(0, end))
            } catch (e: Exception) {
                throw ToolCallParseException("TC-JSON-INVALID", e.message ?: "")
            }
        }
        if (obj !is JsonObject) throw ToolCallParseException("TC-JSON-NOT-OBJECT", obj::class.simpleName ?: "")
        return obj to text.substring(0, idx).trim()
    }

    private fun findJsonToolName(obj0: JsonObject, prefix: String): Pair<String, JsonObject> {
        var obj = obj0
        val fnRaw = obj["function"]
        var fn: JsonElement? = fnRaw
        if (fnRaw is JsonObject) {
            obj = fnRaw
            fn = null
        }
        val name = (obj["name"] as? JsonPrimitive)?.content
            ?: (fn as? JsonPrimitive)?.content
            ?: (obj["function_name"] as? JsonPrimitive)?.content
        if (name == null && PREFIX_NAME_RE.matches(prefix)) {
            return prefix to JsonObject(mapOf("arguments" to obj))
        }
        if (name.isNullOrEmpty()) throw ToolCallParseException("TC-NAME-MISSING")
        return name to obj
    }

    private fun jsonCallArguments(obj: JsonObject): JsonObject {
        var args: JsonElement? = if ("arguments" in obj || "parameters" in obj) {
            obj["arguments"] ?: obj["parameters"]
        } else {
            JsonObject(obj.filterKeys { it !in setOf("name", "function", "function_name") })
        }
        if (args is JsonPrimitive && args.isString) {
            args = try {
                strictDecode(args.content)
            } catch (e: Exception) {
                throw ToolCallParseException("TC-ARGS-INVALID")
            }
        }
        if (args !is JsonObject) throw ToolCallParseException("TC-ARGS-INVALID")
        return args
    }

    private fun parseJsonCall(raw: String, schema: Map<String, JsonObject>): Pair<String, JsonObject> {
        val (obj, prefix) = decodeJsonObject(cleanJsonBlock(raw))
        val (name, obj2) = findJsonToolName(obj, prefix)
        return name to jsonCallArguments(obj2)
    }

    private val PARAM_RE = Regex("<parameter=([^>]*)>(.*?)</parameter>", RegexOption.DOT_MATCHES_ALL)

    private fun trimOneNewline(v0: String): String {
        var v = v0
        if (v.startsWith("\n")) v = v.substring(1)
        if (v.endsWith("\n")) v = v.substring(0, v.length - 1)
        return v
    }

    private val FUNC_HEADER_RE = Regex("<function=([^>]*)>")

    private fun parseFunctionBlock(raw: String, schema: Map<String, JsonObject>): Pair<String, JsonObject> {
        val m = FUNC_HEADER_RE.find(raw) ?: throw ToolCallParseException("TC-FUNC-NO-HEADER")
        val name = m.groupValues[1].trim()
        val props = toolProperties(schema, name)
        val args = linkedMapOf<String, JsonElement>()
        for (pm in PARAM_RE.findAll(raw.substring(m.range.last + 1))) {
            val key = pm.groupValues[1].trim()
            args[key] = coerce(trimOneNewline(pm.groupValues[2]), props, key)
        }
        return name to JsonObject(args)
    }

    private val GLM_ARG_RE = Regex(
        "<arg_key>(.*?)</arg_key>\\s*(?:<arg_value>)?(.*?)(?:</arg_value>|(?=<arg_key>)|$)",
        RegexOption.DOT_MATCHES_ALL,
    )
    private val GLM_BAD_KEY_RE = Regex("(?:</arg_key>\\s*)?<arg_value>([^<]*?)</arg_key>")

    private fun parseGlmBlock(raw0: String, schema: Map<String, JsonObject>): Pair<String, JsonObject> {
        val raw = GLM_BAD_KEY_RE.replace(raw0) { m -> "<arg_key>" + m.groupValues[1] + "</arg_key>" }
        val parts = raw.trim().split("<arg_key>", limit = 2)
        val name = parts[0].trim()
        val rest = if (parts.size > 1) parts[1] else ""
        if (name.isEmpty() || name.startsWith("<")) throw ToolCallParseException("TC-GLM-NO-NAME")
        val props = toolProperties(schema, name)
        val args = linkedMapOf<String, JsonElement>()
        for (m in GLM_ARG_RE.findAll("<arg_key>$rest")) {
            val key = m.groupValues[1].trim()
            args[key] = coerce(trimOneNewline(m.groupValues[2]), props, key)
        }
        return name to JsonObject(args)
    }

    private fun parseBlock(raw: String, schema: Map<String, JsonObject>): Pair<String, JsonObject> = when {
        "<function=" in raw -> parseFunctionBlock(raw, schema)
        "<arg_key>" in raw || "</arg_key>" in raw -> parseGlmBlock(raw, schema)
        else -> parseJsonCall(raw, schema)
    }

    private val EXEC_TOOL = "RunTerminal"
    private val EXEC_ALIASES = setOf(
        "execute_command", "run_command", "execute_commands", "execute", "exec", "bash", "shell",
        "run_shell", "run_terminal_cmd", "terminal", "run_commands",
    )

    private fun commandList(args: JsonObject): List<String>? {
        var cmds: JsonElement? = args["commands"] ?: args["command"] ?: args["cmd"]
        var list: List<JsonElement>? = null
        if (cmds is JsonPrimitive && cmds.isString) list = listOf(cmds)
        if (cmds is JsonArray) list = cmds
        if (list == null || list.isEmpty()) return null
        if (!list.all { it is JsonPrimitive && it.isString && it.content.isNotBlank() }) return null
        return list.map { it.jsonPrimitive.content }
    }

    private fun normalizeCall(parsed: Pair<String, JsonObject>, schema: Map<String, JsonObject>): Pair<String, JsonObject> {
        val (name, args) = parsed
        if (name in schema || name !in EXEC_ALIASES || EXEC_TOOL !in schema) return parsed
        val cmds = commandList(args) ?: return parsed
        if (cmds.size != 1) return parsed
        return EXEC_TOOL to JsonObject(mapOf("command" to JsonPrimitive(cmds.single())))
    }

    private fun findBlockEnd(text: String, m: MatchResult): Pair<String, Int> {
        val start = m.range.last + 1
        val closer = CLOSERS[m.value]
        if (closer != null) {
            val end = text.indexOf(closer, start)
            if (end == -1) return text.substring(start) to text.length
            return text.substring(start, end) to end + closer.length
        }
        val end = text.indexOf("</function>", start)
        if (end == -1) return text.substring(m.range.first) to text.length
        return text.substring(m.range.first, end) + "</function>" to end + "</function>".length
    }

    private fun innermostToolCall(raw: String, opener: String): String {
        if (opener in raw) return raw.substring(raw.lastIndexOf(opener) + opener.length)
        return raw
    }

    private fun readCall(raw: String, schema: Map<String, JsonObject>): Pair<String, JsonObject>? = try {
        normalizeCall(parseBlock(raw, schema), schema)
    } catch (e: ToolCallParseException) {
        null
    }
}

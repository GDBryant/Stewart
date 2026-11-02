package com.adb.stewart.tools

import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolSpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

sealed interface ToolPreview {
    data class FileChange(val path: String, val before: String?, val after: String) : ToolPreview
    data class Command(val command: String, val cwd: String) : ToolPreview
    /** Opt-in marker for the OTHER bypass category; an approval tool without a preview is never bypassed. */
    data object Other : ToolPreview
}

interface Tool {
    val spec: ToolSpec
    val requiresApproval: Boolean
    /**
     * True when execute only waits on the user: no timeout applies, and a cancel leaves
     * nothing uncertain (reported as "Not answered").
     */
    val awaitsUser: Boolean get() = false
    suspend fun preview(arguments: JsonObject): ToolPreview? = null
    suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String
}

class ToolRegistry(tools: List<Tool>) {
    private val byName = tools.associateBy { it.spec.name }
    val tools: List<Tool> = tools
    val specs: List<ToolSpec> = tools.map { it.spec }

    fun find(name: String): Tool? = byName[name]

    fun validate(call: ToolCall): String? {
        val tool = byName[call.name] ?: return "unknown tool '${call.name}'"
        return validateObject(call.arguments, tool.spec.parameters, call.name)
    }

    private fun validateObject(args: JsonObject, schema: JsonObject, name: String): String? {
        val props = (schema["properties"] as? JsonObject) ?: JsonObject(emptyMap())
        val required = (schema["required"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
        for (req in required) {
            if (req !in args) return "missing required argument '$req' for $name"
        }
        for ((key, value) in args) {
            val prop = props[key]
            if (prop == null) {
                if ((schema["additionalProperties"] as? JsonPrimitive)?.booleanOrNull == false) {
                    return "unexpected argument '$key' for $name"
                }
                continue
            }
            val ps = prop as? JsonObject ?: continue
            typeError(value, ps)?.let { return "argument '$key' for $name: $it" }
            val enum = ps["enum"] as? JsonArray
            if (enum != null && enum.none { it == value }) {
                return "argument '$key' for $name: value not in enum"
            }
        }
        return null
    }

    private fun typeError(value: kotlinx.serialization.json.JsonElement, schema: JsonObject): String? {
        val typeEl = schema["type"] ?: return null
        val types = when (typeEl) {
            is JsonPrimitive -> listOf(typeEl.content)
            is JsonArray -> typeEl.mapNotNull { (it as? JsonPrimitive)?.content }
            else -> return null
        }
        val ok = types.any { t ->
            when (t) {
                "string" -> value is JsonPrimitive && value.isString
                "integer" -> value is JsonPrimitive && value.intOrNull != null
                "number" -> value is JsonPrimitive && value.doubleOrNull != null
                "boolean" -> value is JsonPrimitive && value.booleanOrNull != null
                "array" -> value is JsonArray
                "object" -> value is JsonObject
                else -> true
            }
        }
        return if (ok) null else "expected type ${types.joinToString("|")}"
    }
}

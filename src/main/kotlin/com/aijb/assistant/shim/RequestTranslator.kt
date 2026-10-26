package com.aijb.assistant.shim

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolChoice
import com.aijb.assistant.provider.ToolSpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

const val TOOL_BLOCK_TEMPLATE = """# Tools

You may call one or more functions to assist with the user query.
The ONLY tools that exist are the ones listed here. Ignore any other tool definitions you may have been given (e.g. `mcp__local__bash`); they are not available.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{tools_json}
</tools>

For each function call, return a json object with function name and arguments within <{tag}></{tag}> XML tags:
<{tag}>
{{"name": <function-name>, "arguments": <args-json-object>}}
</{tag}>

Rules:
- Emit the <{tag}> block(s) as the LAST thing in your reply, after any explanation.
- Never fabricate a tool result. After emitting a tool call, STOP and wait for the result, which arrives in a <tool_response></tool_response> block.
- Arguments must be valid JSON matching the function's parameters schema."""

object RequestTranslator {

    fun callTag(model: String?): String =
        if ((model ?: "").lowercase().contains("glm")) "call" else "tool_call"

    fun toolBlock(tools: List<ToolSpec>, tag: String): String {
        val lines = tools.joinToString("\n") { t ->
            buildJsonObject {
                put("name", t.name)
                put("description", t.description)
                put("parameters", t.parameters)
            }.toString()
        }
        return TOOL_BLOCK_TEMPLATE
            .replace("{tools_json}", lines)
            .replace("{tag}", tag)
    }

    fun offeredTools(request: ChatRequest): List<ToolSpec> = when (val c = request.toolChoice) {
        ToolChoice.None -> emptyList()
        ToolChoice.Auto -> request.tools
        ToolChoice.Required ->
            if (request.tools.isEmpty()) throw IllegalArgumentException("tool_choice required needs at least one tool")
            else request.tools
        is ToolChoice.Function -> request.tools.filter { it.name == c.name }
            .ifEmpty { throw IllegalArgumentException("tool_choice must select an offered function") }
    }

    fun toolCallsRequired(request: ChatRequest): Boolean =
        request.toolChoice is ToolChoice.Required || request.toolChoice is ToolChoice.Function

    fun toolPolicyError(calls: List<ToolCall>, request: ChatRequest): String? = when {
        toolCallsRequired(request) && calls.isEmpty() ->
            "Upstream did not return the required tool call."
        request.parallelToolCalls == false && calls.size > 1 ->
            "Upstream returned multiple tool calls when parallel_tool_calls is false."
        else -> null
    }

    fun prepare(request: ChatRequest): ChatRequest {
        val tools = offeredTools(request)
        val tag = callTag(request.model)
        val messages = request.messages.toMutableList()
        if (tools.isNotEmpty()) {
            val block = toolBlock(tools, tag)
            if (messages.isNotEmpty() && messages[0].role == Role.SYSTEM) {
                messages[0] = messages[0].copy(content = messages[0].content + "\n\n" + block)
            } else {
                messages.add(0, ChatMessage(Role.SYSTEM, block))
            }
        }
        val callNames = mutableMapOf<String?, String>()
        val out = mutableListOf<ChatMessage>()
        for (msg in messages) {
            var m = msg
            if (m.role == Role.ASSISTANT && m.toolCalls.isNotEmpty()) {
                var text = m.content
                for (call in m.toolCalls) {
                    callNames[call.id] = call.name
                    text += "\n<$tag>\n" + buildJsonObject {
                        put("name", call.name)
                        put("arguments", call.arguments)
                    } + "\n</$tag>"
                }
                m = ChatMessage(Role.ASSISTANT, text.trim())
            } else if (m.role == Role.TOOL) {
                val name = callNames[m.toolCallId] ?: "unknown"
                m = ChatMessage(
                    Role.USER,
                    "<tool_response>\n" + buildJsonObject {
                        put("name", name)
                        put("content", m.content)
                    } + "\n</tool_response>",
                )
            }
            out.add(m)
        }
        return request.copy(
            messages = mergeMessages(out),
            tools = emptyList(),
            toolChoice = ToolChoice.Auto,
            parallelToolCalls = null,
        )
    }

    internal fun mergeMessages(messages: List<ChatMessage>): List<ChatMessage> {
        val merged = mutableListOf<ChatMessage>()
        for (msg in messages) {
            val prev = merged.lastOrNull()
            if (prev != null && prev.role == msg.role) {
                merged[merged.lastIndex] = prev.copy(content = prev.content + "\n\n" + msg.content)
            } else {
                merged.add(msg)
            }
        }
        return merged
    }

    const val RETRY_NUDGE = "Your last reply ended without a tool call. Emit the next tool call now, in the <{tag}> format."

    private val ANNOUNCE_RE = Regex(
        "(?:^|[.!?:]\\s+|\\n)(?:let me (?!know)|i'll |i will |now i |next,? i )[^.!?]*[.:]?\\s*$",
        RegexOption.IGNORE_CASE,
    )

    fun needsRetry(content: String, calls: List<ToolCall>, toolsOffered: Boolean): Boolean {
        if (calls.isNotEmpty() || !toolsOffered) return false
        val text = content.trim()
        if (listOf("<tool_call", "<call>", "<function=").any { it in text }) return true
        return text.isEmpty() || ANNOUNCE_RE.containsMatchIn(text)
    }

    fun isEmptyTurn(content: String, calls: List<ToolCall>, toolsOffered: Boolean): Boolean =
        toolsOffered && calls.isEmpty() && content.isBlank()

    fun retryNudge(model: String): ChatMessage =
        ChatMessage(Role.USER, RETRY_NUDGE.replace("{tag}", callTag(model)))

    fun schemaFor(tools: List<ToolSpec>): Map<String, JsonObject> = tools.associate { it.name to it.parameters }

    fun argsToCompactString(args: JsonObject): String = args.toString()

    fun callName(call: ToolCall): String = call.name
}

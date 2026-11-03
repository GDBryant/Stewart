package com.adb.stewart.provider.claude

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role

internal object ClaudeTranscript {
    fun render(messages: List<ChatMessage>): Pair<String, String> {
        val system = messages.filter { it.role == Role.SYSTEM }
            .joinToString("\n\n") { it.content }
            .ifEmpty { "You are a helpful assistant." }
        val rest = messages.filter { it.role != Role.SYSTEM }
        if (rest.size == 1 && rest[0].role == Role.USER) {
            return system to rest[0].content
        }
        val body = StringBuilder("The conversation so far is below. Reply as the assistant to the last user message.")
        // Raw tool history (e.g. from another provider) is rendered as neutral notes, not as a callable format.
        val callNames = mutableMapOf<String, String>()
        for (msg in rest) {
            val tag = when (msg.role) {
                Role.ASSISTANT -> "assistant"
                Role.TOOL -> "tool_result"
                else -> "user"
            }
            body.append("\n\n<").append(tag)
            if (msg.role == Role.TOOL) {
                callNames[msg.toolCallId]?.let { body.append(" tool=\"").append(it).append('"') }
            }
            body.append(">\n").append(msg.content)
            for (call in msg.toolCalls) {
                callNames[call.id] = call.name
                body.append("\n[called tool ").append(call.name).append(" with arguments ")
                    .append(call.arguments.toString()).append("]")
            }
            body.append("\n</").append(tag).append(">")
        }
        return system to body.toString()
    }
}

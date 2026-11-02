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
        for (msg in rest) {
            body.append("\n\n<").append(if (msg.role == Role.ASSISTANT) "assistant" else "user")
            body.append(">\n").append(msg.content).append("\n</")
            body.append(if (msg.role == Role.ASSISTANT) "assistant" else "user").append(">")
        }
        return system to body.toString()
    }
}

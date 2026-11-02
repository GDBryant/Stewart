package com.adb.stewart.chat

import com.adb.stewart.provider.ChatMessage

object TokenEstimate {
    fun of(messages: List<ChatMessage>): Int =
        messages.sumOf { m ->
            (m.content.length +
                m.toolCalls.sumOf { it.name.length + it.arguments.toString().length } +
                16 + 3) / 4
        }
}

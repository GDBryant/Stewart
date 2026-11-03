package com.adb.stewart.chat

import com.adb.stewart.provider.ChatMessage

object TokenEstimate {
    /** Flat per-image cost; real cost depends on provider and dimensions. */
    const val IMAGE_TOKENS = 1500

    fun of(messages: List<ChatMessage>): Int =
        messages.sumOf { m ->
            (m.content.length +
                m.toolCalls.sumOf { it.name.length + it.arguments.toString().length } +
                16 + 3) / 4 + m.images.size * IMAGE_TOKENS
        }
}

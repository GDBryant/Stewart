package com.adb.stewart.provider.claude

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** Transcript text plus the images that go out as blocks (last user message only). */
internal data class ClaudeInput(val system: String, val text: String, val images: List<ImageAttachment>) {
    val hasImages: Boolean get() = images.isNotEmpty()

    /** One stream-json user line (no trailing newline). */
    fun streamJsonLine(): String = buildJsonObject {
        put("type", "user")
        putJsonObject("message") {
            put("role", "user")
            putJsonArray("content") {
                if (text.isNotBlank()) {
                    addJsonObject {
                        put("type", "text")
                        put("text", text)
                    }
                }
                images.forEach { img ->
                    addJsonObject {
                        put("type", "image")
                        putJsonObject("source") {
                            put("type", "base64")
                            put("media_type", img.mediaType)
                            put("data", img.base64())
                        }
                    }
                }
            }
        }
    }.toString()
}

internal object ClaudeTranscript {
    /** Argv for the CLI; stream-json input is only requested when images are sent. */
    fun argv(cliPath: String, model: String, promptFile: String, streamJsonInput: Boolean): List<String> =
        listOf(cliPath, "-p") +
            (if (streamJsonInput) listOf("--input-format", "stream-json") else emptyList()) +
            listOf(
                "--output-format", "stream-json", "--verbose",
                "--include-partial-messages", "--tools", "", "--safe-mode",
                "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands",
                "--model", model, "--system-prompt-file", promptFile,
            )

    /**
     * Only the last user message's images become blocks; earlier-turn images degrade to
     * `[image: name]` text so stdin stays a single message.
     */
    fun prepare(messages: List<ChatMessage>): ClaudeInput {
        val lastUser = messages.indexOfLast { it.role == Role.USER }
        val flattened = messages.mapIndexed { i, m ->
            if (m.images.isEmpty() || i == lastUser) {
                m
            } else {
                m.copy(
                    content = (listOf(m.content) + m.images.map { "[image: ${it.name}]" })
                        .filter { it.isNotEmpty() }.joinToString("\n"),
                    images = emptyList(),
                )
            }
        }
        val (system, text) = render(flattened)
        return ClaudeInput(system, text, messages.getOrNull(lastUser)?.images.orEmpty())
    }

    /** (system, stdin NDJSON). Text-only conversations should keep using [render]. */
    fun renderStreamJson(messages: List<ChatMessage>): Pair<String, String> {
        val input = prepare(messages)
        return input.system to input.streamJsonLine() + "\n"
    }

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

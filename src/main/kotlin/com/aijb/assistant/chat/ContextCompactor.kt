package com.aijb.assistant.chat

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
import kotlinx.coroutines.CancellationException

class ContextCompactor(private val keepRecent: Int = 4) {

    data class CompactionResult(
        val messages: List<ChatMessage>,
        val compacted: Boolean,
        val error: String? = null,
        val beforeTokens: Int = 0,
        val afterTokens: Int = 0,
        /** Tokens/cost spent on the summary request, whether or not it was used. */
        val usage: Usage? = null,
    )

    suspend fun compactIfNeeded(
        provider: ModelProvider,
        model: String,
        messages: List<ChatMessage>,
        thresholdTokens: Int,
        lastPromptTokens: Int? = null,
    ): CompactionResult {
        val before = TokenEstimate.of(messages)
        val unchanged = CompactionResult(messages, false, beforeTokens = before, afterTokens = before)
        if (before < thresholdTokens && (lastPromptTokens ?: 0) < thresholdTokens) {
            return unchanged
        }
        val prefixEnd = messages.indexOfFirst { it.role != Role.SYSTEM }
            .let { if (it < 0) messages.size else it }
        val prefix = messages.subList(0, prefixEnd)
        val body = messages.subList(prefixEnd, messages.size)
        var cut = body.size - keepRecent
        while (cut > 0 && body[cut].role == Role.TOOL) cut--
        if (cut <= 0) return unchanged
        val older = body.subList(0, cut)
        if (older.size == 1 && older[0].content.startsWith(SUMMARY_PREFIX)) return unchanged
        val kept = body.subList(cut, body.size)

        val summary = StringBuilder()
        var summaryUsage: Usage? = null
        var error: String? = null
        var sawCompleted = false
        try {
            provider.chat(ChatRequest(
                model,
                listOf(
                    ChatMessage(Role.SYSTEM, SUMMARY_PROMPT),
                    ChatMessage(Role.USER, render(older)),
                ),
            )).collect { ev ->
                when (ev) {
                    is ProviderEvent.TextDelta -> summary.append(ev.text)
                    is ProviderEvent.Completed -> {
                        sawCompleted = true
                        summaryUsage = ev.usage
                        if (ev.finishReason == "length" || ev.finishReason == "content_filter") {
                            error = "summary truncated (${ev.finishReason})"
                        }
                    }
                    is ProviderEvent.Failed -> error = ev.message
                    else -> {}
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "summary failed"
        }
        if (error == null && !sawCompleted) error = "summary stream ended before completion"
        if (error == null && summary.isBlank()) error = "empty summary"
        error?.let {
            return CompactionResult(messages, false, it, before, before, summaryUsage)
        }

        val summaryText = SUMMARY_PREFIX + "\n" + summary.toString().trim()
        val first = kept.first()
        val tail = if (first.role == Role.USER && first.toolCalls.isEmpty() && first.toolCallId == null) {
            listOf(ChatMessage(Role.USER, summaryText + "\n\n" + first.content)) + kept.drop(1)
        } else {
            listOf(ChatMessage(Role.USER, summaryText)) + kept
        }
        val result = prefix + tail
        return CompactionResult(
            result, true, beforeTokens = before, afterTokens = TokenEstimate.of(result), usage = summaryUsage)
    }

    private fun render(messages: List<ChatMessage>): String =
        messages.joinToString("\n\n") { m ->
            buildString {
                if (m.role == Role.TOOL) {
                    append("[tool result ${m.toolCallId}] ")
                    append(
                        if (m.content.length > 2000) {
                            m.content.take(2000) + "…[truncated]"
                        } else {
                            m.content
                        }
                    )
                } else {
                    append("[${m.role.name.lowercase()}] ${m.content}")
                    m.toolCalls.forEach { call ->
                        append("\n[tool call ${call.id}] ${call.name} ${call.arguments}")
                    }
                }
            }
        }

    companion object {
        const val SUMMARY_PREFIX = "[Summary of earlier conversation]"
        const val SUMMARY_PROMPT = "You compress conversations. Summarize the conversation below so another assistant can continue it without the original. Keep: the user's goals and constraints, decisions made, facts learned, file paths, code identifiers, commands run and their outcomes, tool results that still matter, and open tasks or questions. Drop pleasantries and repetition. Do not invent anything. Output only the summary, as concise bullet points."
    }
}

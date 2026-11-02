package com.adb.stewart.tools

import com.adb.stewart.chat.ContextCompactor
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.Usage
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject

sealed interface ApprovalDecision {
    data object Approved : ApprovalDecision
    data class Rejected(val reason: String) : ApprovalDecision
}

fun interface ApprovalGate {
    suspend fun review(call: ToolCall, preview: ToolPreview?): ApprovalDecision
}

sealed interface ToolOutcome {
    data class Success(val content: String) : ToolOutcome
    data class Failure(val message: String) : ToolOutcome
    data class Rejected(val reason: String) : ToolOutcome
    data class Invalid(val reason: String) : ToolOutcome
    data class Uncertain(val reason: String) : ToolOutcome
}

interface LoopListener {
    fun onText(text: String) {}
    fun onReasoning(text: String) {}
    fun onToolRequested(call: ToolCall) {}
    fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) {}
    fun onCompacted(beforeTokens: Int, afterTokens: Int) {}
    fun onCompactionFailed(message: String) {}
}

data class LoopLimits(
    val maxModelTurns: Int = 10,
    val toolTimeout: Duration = 60.seconds,
    val maxToolOutputChars: Int = 20_000,
    val maxContextChars: Int = 400_000,
    val compactAtTokens: Int? = null,
    /** Consecutive "output token limit" truncations answered by compacting and retrying. */
    val maxTruncationRetries: Int = 1,
)

const val UNCERTAIN_PREFIX = "Outcome uncertain:"
const val NOT_ANSWERED_CANCELLED = "Not answered: cancelled"

/**
 * Thrown (as a cancellation) when a run is cancelled, carrying everything produced so far so the
 * caller can keep an honest transcript: partial reply text, tool results and any tool call whose
 * outcome is unknown. Nothing is claimed rolled back.
 */
class RunCancelledException(
    val base: List<ChatMessage>,
    val produced: List<ChatMessage>,
    cause: Throwable? = null,
    /** Tokens and cost already spent by the cancelled run. */
    val usage: Usage? = null,
) : CancellationException("cancelled") {
    init {
        initCause(cause)
    }

    val transcript: List<ChatMessage> get() = base + produced

    val uncertainOutcomes: Int
        get() = produced.count { it.role == Role.TOOL && it.content.startsWith(UNCERTAIN_PREFIX) }
}

private class InFlight {
    var id: String? = null
    var awaitsUser = false
}

sealed interface LoopResult {
    val messages: List<ChatMessage>
    val base: List<ChatMessage>
    /** Usage summed over every model turn and compaction request, however the run ended. */
    val usage: Usage?
    val transcript: List<ChatMessage> get() = base + messages
    data class Completed(
        override val messages: List<ChatMessage>,
        override val usage: Usage?,
        override val base: List<ChatMessage>,
        /** The terminal tool call that ended the run, or null when the model simply finished. */
        val submitted: ToolCall? = null,
    ) : LoopResult
    data class TurnLimitReached(
        override val messages: List<ChatMessage>,
        override val base: List<ChatMessage>,
        override val usage: Usage? = null,
    ) : LoopResult
    data class Failed(
        override val messages: List<ChatMessage>,
        val message: String,
        val code: String? = null,
        override val base: List<ChatMessage>,
        override val usage: Usage? = null,
    ) : LoopResult
}

class ToolLoop(
    private val provider: ModelProvider,
    private val registry: ToolRegistry,
    private val approval: ApprovalGate,
    private val limits: LoopLimits = LoopLimits(),
    private val compactor: ContextCompactor = ContextCompactor(),
    private val rolePrompt: String? = null,
    private val terminalTools: Set<String> = emptySet(),
) {

    suspend fun run(
        model: String,
        history: List<ChatMessage>,
        listener: LoopListener,
        lastPromptTokens: Int? = null,
    ): LoopResult {
        val produced = mutableListOf<ChatMessage>()
        var base: List<ChatMessage> = history
        var lastPromptTokens: Int? = lastPromptTokens
        var turns = 0
        var truncationRetries = 0
        var total: Usage? = null
        val text = StringBuilder()
        var turnOpen = false
        val inFlight = InFlight()
        try {
            while (true) {
                if (turns >= limits.maxModelTurns) return LoopResult.TurnLimitReached(produced, base, total)
                limits.compactAtTokens?.let { threshold ->
                    val compaction = compactor.compactIfNeeded(
                        provider, model, base + produced, threshold, lastPromptTokens)
                    compaction.usage?.let { u -> total = total?.plus(u) ?: u }
                    if (compaction.error != null) {
                        listener.onCompactionFailed(compaction.error!!)
                    } else if (compaction.compacted) {
                        base = compaction.messages
                        produced.clear()
                        listener.onCompacted(compaction.beforeTokens, compaction.afterTokens)
                    }
                }
                val context = base + produced
                val size = context.sumOf { it.content.length } +
                    context.sumOf { m -> m.toolCalls.sumOf { it.arguments.toString().length } }
                if (size > limits.maxContextChars) {
                    return LoopResult.Failed(produced, "context size limit exceeded", "context_limit", base, total)
                }
                turns++
                text.setLength(0)
                turnOpen = true
                var calls: List<ToolCall> = emptyList()
                var usage: Usage? = null
                var finish: String? = null
                var failed: ProviderEvent.Failed? = null
                var protocolError = false
                val outbound = rolePrompt?.let {
                    listOf(ChatMessage(Role.SYSTEM, it)) + context
                } ?: context
                provider.chat(ChatRequest(model, outbound, tools = registry.specs)).collect { ev ->
                    when (ev) {
                        is ProviderEvent.TextDelta -> {
                            if (finish != null) protocolError = true
                            else { text.append(ev.text); listener.onText(ev.text) }
                        }
                        is ProviderEvent.ReasoningDelta -> {
                            if (finish != null) protocolError = true else listener.onReasoning(ev.text)
                        }
                        is ProviderEvent.ToolCalls -> {
                            if (finish != null) protocolError = true else calls = ev.calls
                        }
                        is ProviderEvent.NativeToolCalls -> {
                            protocolError = true
                        }
                        is ProviderEvent.Completed -> {
                            if (finish != null) protocolError = true
                            finish = ev.finishReason
                            usage = ev.usage
                        }
                        is ProviderEvent.Failed -> {
                            if (finish != null) protocolError = true else failed = ev
                        }
                    }
                }
                lastPromptTokens = usage?.promptTokens
                usage?.let { u -> total = total?.plus(u) ?: u }
                if (protocolError) {
                    return LoopResult.Failed(produced, "provider emitted events after completion", "protocol_error", base, total)
                }
                if (failed != null) {
                    return LoopResult.Failed(produced, failed!!.message, failed!!.code, base, total)
                }
                if (finish == null) {
                    return LoopResult.Failed(produced, "stream ended before completion", "incomplete_stream", base, total)
                }
                if (finish == "length" && truncationRetries < limits.maxTruncationRetries) {
                    // Output limit hit: drop the partial reply, compact the context and retry.
                    turnOpen = false
                    val compaction = compactor.compactIfNeeded(provider, model, base + produced, 0, null)
                    compaction.usage?.let { u -> total = total?.plus(u) ?: u }
                    if (compaction.error != null) {
                        listener.onCompactionFailed(compaction.error!!)
                    } else if (compaction.compacted) {
                        truncationRetries++
                        base = compaction.messages
                        produced.clear()
                        lastPromptTokens = null
                        listener.onCompacted(compaction.beforeTokens, compaction.afterTokens)
                        continue
                    }
                }
                if (finish == "length" || finish == "content_filter") {
                    turnOpen = false
                    produced.add(ChatMessage(Role.ASSISTANT, text.toString()))
                    return LoopResult.Failed(produced, "response truncated ($finish)", "truncated", base, total)
                }
                truncationRetries = 0
                turnOpen = false
                produced.add(ChatMessage(Role.ASSISTANT, text.toString(), toolCalls = calls))
                if (calls.isEmpty()) return LoopResult.Completed(produced, total, base)
                val seen = mutableSetOf<String>()
                for (call in calls) {
                    listener.onToolRequested(call)
                    val outcome = executeCall(call, seen, listener, inFlight)
                    produced.add(ChatMessage(Role.TOOL, outcomeMessage(outcome), toolCallId = call.id))
                    if (call.name in terminalTools && outcome is ToolOutcome.Success) {
                        return LoopResult.Completed(produced, total, base, submitted = call)
                    }
                }
            }
        } catch (e: CancellationException) {
            closeOpenToolCalls(produced, inFlight)
            if (turnOpen && text.isNotBlank()) produced.add(ChatMessage(Role.ASSISTANT, text.toString()))
            throw RunCancelledException(base, produced, e, total)
        }
    }

    /** Gives every unanswered tool call of the last assistant turn a result so the transcript stays valid. */
    private fun closeOpenToolCalls(produced: MutableList<ChatMessage>, inFlight: InFlight) {
        val idx = produced.indexOfLast { it.role == Role.ASSISTANT && it.toolCalls.isNotEmpty() }
        if (idx < 0) return
        val answered = produced.drop(idx + 1).mapNotNull { it.toolCallId }.toSet()
        for (call in produced[idx].toolCalls) {
            if (call.id in answered) continue
            val content = if (call.id == inFlight.id) {
                if (inFlight.awaitsUser) NOT_ANSWERED_CANCELLED
                else outcomeMessage(ToolOutcome.Uncertain("cancelled; side effects unknown"))
            } else {
                "Not executed: cancelled by user"
            }
            produced.add(ChatMessage(Role.TOOL, content, toolCallId = call.id))
        }
    }

    private suspend fun executeCall(
        call: ToolCall,
        seen: MutableSet<String>,
        listener: LoopListener,
        inFlight: InFlight,
    ): ToolOutcome {
        val outcome: ToolOutcome = when {
            !seen.add(call.id) -> ToolOutcome.Invalid("duplicate tool call id")
            registry.find(call.name) == null -> ToolOutcome.Invalid("unknown tool '${call.name}'")
            else -> {
                val invalid = registry.validate(call)
                if (invalid != null) {
                    ToolOutcome.Invalid(invalid)
                } else {
                    val tool = registry.find(call.name)!!
                    var preview: ToolPreview? = null
                    if (tool.requiresApproval) {
                        preview = try {
                            tool.preview(call.arguments)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            return finishOutcome(call, ToolOutcome.Failure(e.message ?: "preview failed"), listener)
                        }
                        val decision = approval.review(call, preview)
                        if (decision is ApprovalDecision.Rejected) {
                            return finishOutcome(call, ToolOutcome.Rejected(decision.reason), listener)
                        }
                    }
                    inFlight.id = call.id
                    inFlight.awaitsUser = tool.awaitsUser
                    try {
                        val out = if (tool.awaitsUser) {
                            tool.execute(call.arguments, preview)
                        } else {
                            withTimeout(limits.toolTimeout) { tool.execute(call.arguments, preview) }
                        }
                        ToolOutcome.Success(
                            if (out.length > limits.maxToolOutputChars) {
                                out.take(limits.maxToolOutputChars) + "\n[output truncated]"
                            } else out
                        )
                    } catch (e: CancellationException) {
                        if (currentCoroutineContext().isActive) {
                            ToolOutcome.Uncertain("timed out; side effects unknown")
                        } else {
                            withContext(NonCancellable) {
                                listener.onToolOutcome(
                                    call,
                                    if (tool.awaitsUser) ToolOutcome.Failure(NOT_ANSWERED_CANCELLED)
                                    else ToolOutcome.Uncertain("cancelled; side effects unknown"),
                                )
                            }
                            throw e
                        }
                    } catch (e: Exception) {
                        ToolOutcome.Failure(e.message ?: "tool failed")
                    }
                }
            }
        }
        return finishOutcome(call, outcome, listener)
    }

    private fun finishOutcome(call: ToolCall, outcome: ToolOutcome, listener: LoopListener): ToolOutcome {
        listener.onToolOutcome(call, outcome)
        return outcome
    }

    private fun outcomeMessage(outcome: ToolOutcome): String = when (outcome) {
        is ToolOutcome.Success -> outcome.content
        is ToolOutcome.Failure -> "Error: ${outcome.message}"
        is ToolOutcome.Rejected -> "Rejected by user: ${outcome.reason}"
        is ToolOutcome.Invalid -> "Invalid tool call: ${outcome.reason}"
        is ToolOutcome.Uncertain -> "$UNCERTAIN_PREFIX ${outcome.reason}"
    }
}

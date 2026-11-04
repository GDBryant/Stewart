package com.adb.stewart.agents

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.tools.UNCERTAIN_PREFIX
import kotlinx.serialization.json.JsonPrimitive

/** Faults a level can recover from before falling through to re-planning. */
enum class FaultKind { TRUNCATED, INCOMPLETE_STREAM, TURN_LIMIT }

data class RecoverableFault(val kind: FaultKind, val role: AgentRole?, val message: String)

/** Classifies a finished level; null for completed runs and every non-recoverable failure. */
internal fun classify(run: LevelRun): RecoverableFault? = when (val s = run.status) {
    is LevelStatus.Completed -> null
    is LevelStatus.TurnLimit -> RecoverableFault(FaultKind.TURN_LIMIT, run.role, "turn limit reached")
    is LevelStatus.Failed -> when (s.code) {
        "truncated" -> RecoverableFault(FaultKind.TRUNCATED, run.role, s.message)
        "incomplete_stream" -> RecoverableFault(FaultKind.INCOMPLETE_STREAM, run.role, s.message)
        else -> null
    }
}

private val PROGRESS_TOOLS = setOf("EditFile", "WriteFile", "RunTerminal")
private val FAILURE_PREFIXES = listOf(
    "Error:", "Rejected by user", "Invalid tool call", UNCERTAIN_PREFIX, "Not executed", "Not answered")
private const val REPEAT_LIMIT = 3
private const val STALL_TURNS = 5
private const val CONTEXT_CAP = 600

private fun isFailureResult(content: String) = FAILURE_PREFIXES.any { content.startsWith(it) }

/** Successful calls in order: the call paired with its non-error tool result. */
private fun successfulCalls(messages: List<ChatMessage>): List<ToolCall> {
    val byId = messages.filter { it.role == Role.TOOL }.associateBy { it.toolCallId }
    return messages.filter { it.role == Role.ASSISTANT }.flatMap { it.toolCalls }
        .filter { c -> byId[c.id]?.let { !isFailureResult(it.content) } == true }
}

/** Returns why the worker looks stuck, or null. Never blocks anything; it only picks the recommended option. */
fun detectStuck(messages: List<ChatMessage>): String? {
    val calls = messages.filter { it.role == Role.ASSISTANT }.flatMap { it.toolCalls }
    val repeated = calls.groupingBy { it.name to it.arguments }.eachCount().entries
        .firstOrNull { it.value >= REPEAT_LIMIT }
    if (repeated != null) return "${repeated.key.first} called ${repeated.value} times with identical arguments"
    val turns = messages.filter { it.role == Role.ASSISTANT }
    if (turns.size >= STALL_TURNS) {
        val last = turns.takeLast(STALL_TURNS)
        val ids = last.flatMap { it.toolCalls }.map { it.id }.toSet()
        val ok = successfulCalls(messages).any { it.id in ids && it.name in PROGRESS_TOOLS }
        if (!ok) return "no successful edit, write or terminal call in the last $STALL_TURNS turns"
    }
    return null
}

private fun clip(s: String, n: Int) = if (s.length <= n) s else s.take(n - 1) + "…"

private fun describe(c: ToolCall): String {
    val arg = listOf("path", "command").firstNotNullOfOrNull { k ->
        (c.arguments[k] as? JsonPrimitive)?.content
    }
    return if (arg == null) c.name else "${c.name} ${clip(arg.replace('\n', ' '), 50)}"
}

/** Option labels, recommended first: Continue, Split, Stop; Split first when stuck. Split omitted without orchestration. */
fun continueOptions(stuck: Boolean, extraTurns: Int, withSplit: Boolean): List<String> {
    val cont = "Continue (+$extraTurns turns)"
    val split = "Split into smaller tasks"
    val stop = "Stop this task"
    return when {
        !withSplit -> listOf(cont, stop)
        stuck -> listOf(split, cont, stop)
        else -> listOf(cont, split, stop)
    }
}

/** Question context for a worker that hit its turn limit; capped at about 600 chars, options line kept intact. */
fun continueQuestionText(
    turnLimit: Int,
    taskId: String,
    description: String,
    messages: List<ChatMessage>,
    stuckReason: String?,
    extraTurns: Int,
    withSplit: Boolean = true,
    /** Plain chat (no worker task): own wording, [description] is the user prompt. */
    plainChat: Boolean = false,
): String {
    val done = successfulCalls(messages).takeLast(5).joinToString("; ") { describe(it) }
        .ifEmpty { "nothing yet" }
    val last = messages.filter { it.role == Role.ASSISTANT }.flatMap { it.toolCalls }.lastOrNull()
        ?.let { describe(it) } ?: "none"
    val head = buildString {
        if (plainChat) append("Hit the tool-turn limit ($turnLimit) on: \"${clip(description, 120)}\".\n")
        else append("Worker hit its turn limit ($turnLimit) on task $taskId: \"${clip(description, 120)}\".\n")
        append("Done so far: $done. Last action: $last.")
        if (stuckReason != null) append("\nLooks stuck: $stuckReason")
    }
    val opts = continueOptions(stuckReason != null, extraTurns, withSplit)
    val tail = "\n\nOptions: " + opts.joinToString(" · ")
    return clip(head, (CONTEXT_CAP - tail.length).coerceAtLeast(0)) + tail
}

/** Successful tool calls so far as tool plus path or command, for the layer-1 recovery brief. */
internal fun recoveryActions(messages: List<ChatMessage>): List<RecoveryAction> =
    successfulCalls(messages).filter { it.name != Protocol.SUBMIT_RESULT }.map { c ->
        val target = listOf("path", "command").firstNotNullOfOrNull { k ->
            (c.arguments[k] as? JsonPrimitive)?.content
        }.orEmpty()
        RecoveryAction(c.name, clip(target.replace('\n', ' '), 80))
    }

package com.adb.stewart.agents

import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolPreview
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Blocks until the user answers; cancelling the caller cancels the wait. */
fun interface UserPrompter {
    suspend fun ask(question: String, options: List<String>): String
}

/**
 * Non-terminal Planner tool (Open Question 3). At most [maxQuestions] questions are allowed per
 * run; later ones fail as ordinary tool errors so the model plans with what it has.
 */
class AskUserTool(
    private val prompter: UserPrompter,
    private val maxQuestions: Int,
    private val onQuestion: (question: String, options: List<String>) -> Unit = { _, _ -> },
) : Tool {
    private var asked = 0

    override val spec = ToolSpec(
        Protocol.ASK_USER,
        "Ask the user one clarifying question and wait for the answer. Only when the request is " +
            "ambiguous in a way that changes the plan. Optional options are suggested answers.",
        buildJsonObject {
            put("type", JsonPrimitive("object"))
            put(
                "properties",
                buildJsonObject {
                    put("question", buildJsonObject { put("type", JsonPrimitive("string")) })
                    put(
                        "options",
                        buildJsonObject {
                            put("type", JsonPrimitive("array"))
                            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
                        },
                    )
                },
            )
            put("required", JsonArray(listOf(JsonPrimitive("question"))))
            put("additionalProperties", JsonPrimitive(false))
        },
    )

    override val requiresApproval = false
    override val awaitsUser = true

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val question = arguments["question"]?.jsonPrimitive?.content?.trim()
        if (question.isNullOrEmpty()) throw ProtocolException("'question' must not be blank")
        val options = when (val el = arguments["options"]) {
            null -> emptyList()
            is JsonArray -> el.map { o ->
                (o as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
                    ?: throw ProtocolException("'options' must contain only strings")
            }.filter { it.isNotEmpty() }
            else -> throw ProtocolException("'options' must be an array")
        }
        if (asked >= maxQuestions) {
            throw ProtocolException("question limit reached (max $maxQuestions); plan with what you know")
        }
        asked++
        onQuestion(question, options)
        return prompter.ask(question, options)
    }
}

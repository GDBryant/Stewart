package com.adb.stewart.agents

import com.adb.stewart.provider.ToolSpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

// Layer 1 (worker split), pure parts: submit_recovery tool + parser, brief, join, merge.

const val SUBMIT_RECOVERY = "submit_recovery"

data class RecoverySubTask(val description: String, val outputFile: String, val maxTurns: Int? = null)

data class RecoveryPlan(
    val subtasks: List<RecoverySubTask>,
    val finalFile: String? = null,
    val advice: String? = null,
)

/** One successful action so far: tool name plus its path or command. */
data class RecoveryAction(val tool: String, val target: String)

/** Assembly cannot proceed (e.g. a sub-task output is missing); recovery has failed. */
class RecoveryAssemblyException(message: String) : RuntimeException(message)

object SplitRecovery {
    private fun reject(message: String): Nothing = throw ProtocolException(message)

    private fun str() = JsonObject(mapOf("type" to JsonPrimitive("string")))

    fun recoveryTool(limits: OrchestratorLimits) = ProtocolTool(
        ToolSpec(
            SUBMIT_RECOVERY,
            "Split the failed task into 2 to ${limits.maxSubTasks} smaller sub-tasks run one after another. " +
                "Each sub-task writes its full output to its own output_file (a bare file name). " +
                "Optionally set final_file (project-relative) to have the outputs joined in order into that file.",
            buildJsonObject {
                put("type", JsonPrimitive("object"))
                put("properties", buildJsonObject {
                    put("subtasks", buildJsonObject {
                        put("type", JsonPrimitive("array"))
                        put("minItems", JsonPrimitive(2))
                        put("maxItems", JsonPrimitive(limits.maxSubTasks))
                        put("items", buildJsonObject {
                            put("type", JsonPrimitive("object"))
                            put("properties", buildJsonObject {
                                put("description", str())
                                put("output_file", str())
                                put("max_turns", buildJsonObject {
                                    put("type", JsonPrimitive("integer"))
                                    put("description", JsonPrimitive("Optional Worker turn limit; between 1 and ${limits.maxWorkerTurnsCeiling}."))
                                })
                            })
                            put("required", JsonArray(listOf(JsonPrimitive("description"), JsonPrimitive("output_file"))))
                            put("additionalProperties", JsonPrimitive(false))
                        })
                    })
                    put("final_file", str())
                    put("advice", str())
                })
                put("required", JsonArray(listOf(JsonPrimitive("subtasks"))))
                put("additionalProperties", JsonPrimitive(false))
            },
        ),
        { args -> parseRecovery(args, limits.maxSubTasks, limits.maxWorkerTurnsCeiling) },
    )

    fun parseRecovery(args: JsonObject, maxSubTasks: Int, turnCeiling: Int): RecoveryPlan {
        val arr = args["subtasks"] as? JsonArray ?: reject("'subtasks' must be an array")
        if (arr.size < 2 || arr.size > maxSubTasks) reject("'subtasks' must contain 2 to $maxSubTasks entries (got ${arr.size})")
        val seen = mutableSetOf<String>()
        val subs = arr.mapIndexed { i, el ->
            val obj = el as? JsonObject ?: reject("subtask $i is not an object")
            val desc = (obj["description"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (desc.isNullOrBlank()) reject("subtask $i missing 'description'")
            val file = (obj["output_file"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (file.isNullOrBlank()) reject("subtask $i missing 'output_file'")
            if (!isBareName(file)) reject("subtask $i output_file '$file' must be a bare file name (no path separators or '..')")
            if (!seen.add(file)) reject("duplicate output_file '$file'")
            val turns = (obj["max_turns"] as? JsonPrimitive)?.takeIf { !it.isString }?.let { p ->
                val n = p.intOrNull ?: p.content.toDoubleOrNull()?.let { reject("subtask $i max_turns must be an integer (got ${p.content})") }
                n
            }
            if (turns != null && (turns < 1 || turns > turnCeiling)) {
                reject("subtask $i max_turns must be between 1 and $turnCeiling (got $turns)")
            }
            RecoverySubTask(desc, file, turns)
        }
        val finalFile = (args["final_file"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
        if (finalFile != null && !isRelativePath(finalFile)) {
            reject("final_file '$finalFile' must be a project-relative path without '..'")
        }
        val advice = (args["advice"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
        return RecoveryPlan(subs, finalFile, advice)
    }

    private fun isBareName(s: String) =
        s.isNotBlank() && '/' !in s && '\\' !in s && ".." !in s && !Regex("^[A-Za-z]:").containsMatchIn(s)

    private fun isRelativePath(s: String): Boolean {
        if (s.isBlank() || s.startsWith("/") || s.startsWith("\\") || Regex("^[A-Za-z]:").containsMatchIn(s)) return false
        return s.split('/', '\\').none { it == ".." }
    }

    /** User content for the PLANNER-route recovery call. No transcript: just the facts. */
    fun buildBrief(
        task: DispatchTask,
        fault: RecoverableFault,
        actions: List<RecoveryAction>,
        scratchFiles: List<String>,
        limits: OrchestratorLimits,
        milestoneDone: String? = null,
    ): String = buildString {
        appendLine("A Worker failed this task with a recoverable fault: ${fault.kind} (${fault.message}).")
        appendLine("Task ${task.id}: ${task.description}")
        if (!milestoneDone.isNullOrBlank()) appendLine("Milestone definition of done: $milestoneDone")
        val shown = actions.take(limits.maxActionsInRecoveryBrief)
        if (shown.isEmpty()) {
            appendLine("Actions so far: none.")
        } else {
            appendLine("Actions so far (files may already be written; sub-tasks must not blindly redo or undo them):")
            shown.forEach { appendLine("- ${it.tool}: ${it.target}") }
            if (actions.size > shown.size) appendLine("- ... and ${actions.size - shown.size} more")
        }
        if (scratchFiles.isNotEmpty()) appendLine("Existing scratch files: ${scratchFiles.joinToString(", ")}")
        appendLine()
        append("Call $SUBMIT_RECOVERY with 2 to ${limits.maxSubTasks} smaller sub-tasks, each writing its output to its own bare-named output_file. ")
        append("Set final_file (project-relative) if the outputs should be joined into one file. No other tools are available.")
    }

    /** Joins sub-task outputs in subtask order. A missing output fails assembly (no partial file). */
    fun joinOutputs(plan: RecoveryPlan, outputs: Map<String, String>): String =
        plan.subtasks.joinToString("") { st ->
            outputs[st.outputFile] ?: throw RecoveryAssemblyException("missing output for ${st.outputFile}")
        }

    /** Merges sub-task results: done only if all done, else failed; summary bounded by [maxChars]. */
    fun mergeResults(
        parentId: Int,
        plan: RecoveryPlan,
        results: List<WorkerResult>,
        recoverySummaryChars: Int,
        maxHandoffChars: Int,
    ): WorkerResult {
        val status = if (results.isNotEmpty() && results.all { it.status == "done" }) "done" else "failed"
        val lines = results.mapIndexed { i, r ->
            val file = plan.subtasks.getOrNull(i)?.outputFile
            "${i + 1}. [${r.status}] ${r.summary.take(recoverySummaryChars)}" + (file?.let { " (file: $it)" } ?: "")
        }
        val summary = buildString {
            append(lines.joinToString("\n"))
            plan.finalFile?.let { append("\nfinal_file: $it") }
        }.take(maxHandoffChars)
        return WorkerResult(parentId, status, summary)
    }
}

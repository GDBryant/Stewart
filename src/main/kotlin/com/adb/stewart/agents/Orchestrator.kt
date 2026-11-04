package com.adb.stewart.agents

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.debug.DebugLogSink
import com.adb.stewart.chat.ContextCompactor
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolSpec
import com.adb.stewart.provider.Usage
import com.adb.stewart.tools.ApprovalDecision
import com.adb.stewart.tools.ApprovalGate
import com.adb.stewart.tools.LoopLimits
import com.adb.stewart.tools.LoopListener
import com.adb.stewart.tools.LoopResult
import com.adb.stewart.tools.RunCancelledException
import com.adb.stewart.tools.Tool
import com.adb.stewart.tools.ToolLoop
import com.adb.stewart.tools.ToolRegistry
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// Structured protocol between the three levels (see PLAN.md, milestone 6).
//
//   plan:    {"goal": "...", "milestones": [{"id": 1, "title": "...", "notes": "..."}]}
//   task:    {"tasks": [{"id": 1, "description": "...", "files": ["a.kt"], "depends_on": [1]}]}
//   result:  {"task_id": 1, "status": "done" | "failed", "summary": "..."}
//
// Each level is a ToolLoop with its role prompt plus a protocol block. Levels submit
// their structured messages through terminal tools (submit_plan / submit_tasks /
// complete_milestone / submit_result). Each protocol tool validates its own arguments
// (schema plus parsePlan/parseTasks/parseResult and the size limits); a rejection comes back
// as an ordinary tool error so the model retries within the level's turn budget. Milestones run in order; within a
// milestone the Executor may submit task rounds (bounded by maxTaskRounds) until it
// completes the milestone. An unmet milestone triggers a bounded Planner re-plan and
// the run resumes at that milestone.

object Protocol {
    const val SUBMIT_PLAN = "submit_plan"
    const val SUBMIT_TASKS = "submit_tasks"
    const val COMPLETE_MILESTONE = "complete_milestone"
    const val SUBMIT_RESULT = "submit_result"
    const val ASK_USER = "ask_user"

    const val PLANNER =
        "Protocol: call ${SUBMIT_PLAN} exactly when you have the full plan. Arguments: {\"goal\": \"<overall goal>\", \"milestones\": [{\"id\": 1, \"title\": \"<short title>\", \"notes\": \"<what must be true when done>\", \"turn_budget\": <optional integer: suggested Worker turns per task; raise it for large milestones>}]}. Milestones must be ordered and independently checkable. You have no project tools; do not do task-level work."

    /** Standing size rule added to the re-plan prompt (layer 2). */
    const val SIZE_RULE =
        "Keep milestones and tasks small. No single reply or file write should exceed ~150 lines; split larger output across files. Set turn_budget for milestones that need many tool steps."

    const val REPLAN =
        "Protocol: a milestone could not be completed. Call ${SUBMIT_PLAN} with a corrected plan covering the remaining work: start the milestones at id ${'$'}NEXT_ID and keep them ordered and independently checkable. You have no project tools."

    /** Appended to the Planner prompts only when a [UserPrompter] is available. */
    const val ASK_USER_HINT =
        " You may call ${ASK_USER} with {\"question\": \"<one question>\", \"options\": [\"<suggested answers>\"]} to ask the user, but only when the request is ambiguous in a way that changes the plan; otherwise just plan. Questions are limited, so ask the most important one first."

    const val EXECUTOR =
        "Protocol: to dispatch work, call ${SUBMIT_TASKS} with {\"tasks\": [{\"id\": 1, \"description\": \"<one concrete task a single Worker can finish alone>\", \"files\": [\"<relevant paths>\"], \"depends_on\": [<ids of earlier tasks in this round whose results it needs>], \"max_turns\": <optional integer: Worker turn limit; raise it for tasks you expect to be large, otherwise omit>}]}. Fill in files and depends_on: the Worker sees only its own task, those files and the results of the tasks it depends on. After the Worker results arrive, call ${COMPLETE_MILESTONE} with {\"notes\": \"<evidence the milestone is done>\"} when the milestone is met, or ${SUBMIT_TASKS} again with corrected or new tasks when it is not."

    const val WORKER =
        "Protocol: carry out exactly the given task using the available tools. When finished, or if you cannot finish, call ${SUBMIT_RESULT} with {\"task_id\": <id>, \"status\": \"done\" | \"failed\", \"summary\": \"<what you did, or why it failed>\"}. Do not plan beyond the task."
}

/** The fault behind a failed milestone and what recovery tried, passed to the re-plan. */
data class FaultNote(val kind: FaultKind, val message: String, val recoveryAttempts: List<String>)

data class Milestone(val id: Int, val title: String, val notes: String, val turnBudget: Int? = null)
data class Plan(val goal: String, val milestones: List<Milestone>)
data class DispatchTask(
    val id: Int,
    val description: String,
    val files: List<String> = emptyList(),
    val dependsOn: List<Int> = emptyList(),
    val maxTurns: Int? = null,
)
data class WorkerResult(val taskId: Int, val status: String, val summary: String)

class ProtocolException(message: String) : RuntimeException(message)

/**
 * A terminal protocol tool that validates its own arguments: a [ProtocolException] from [parse]
 * reaches the model as a normal tool error so it can resubmit. [accepted] holds the last valid
 * submission; make one tool per level run.
 */
class ProtocolTool<T>(
    override val spec: ToolSpec,
    private val parse: (JsonObject) -> T,
) : Tool {
    var accepted: T? = null
        private set

    override val requiresApproval = false

    override suspend fun execute(arguments: JsonObject, preview: com.adb.stewart.tools.ToolPreview?): String {
        accepted = parse(arguments)
        return "accepted"
    }
}

interface OrchestratorListener {
    fun onDelta(text: String)
    /** Fired before a level's first request, naming the provider/model it will be sent to. */
    fun onLevelRouted(role: AgentRole, destination: String) {}
    fun onLevelStarted(role: AgentRole, context: String)
    fun onPlan(plan: Plan)
    fun onTasks(taskRound: Int, tasks: List<DispatchTask>)
    fun onResult(result: WorkerResult)
    fun onReplanning(reason: String)
    /** Fired when a fault is being recovered; [detail] is the status line, [depth] the split nesting (0 = top). */
    fun onRecovering(kind: FaultKind, detail: String, depth: Int) {}
    /** Fired when the Planner asks the user a question, just before the run blocks for the answer. */
    fun onQuestion(question: String, options: List<String>) {}
    /** Fired when a pending question timed out and was withdrawn; clears any pending UI. */
    fun onQuestionWithdrawn() {}
    fun onCompleted(usage: Usage?)
    fun onFailed(message: String)
}

data class OrchestratorLimits(
    val maxMilestones: Int = 8,
    val maxTasksPerRound: Int = 10,
    val maxTaskRounds: Int = 3,
    val maxReplans: Int = 2,
    val maxLevelModelTurns: Int = 15,
    val toolTimeout: Duration = 120.seconds,
    val maxHandoffChars: Int = 2000,
    /** Planner questions to the user per run (initial plan and re-plans together). */
    val maxQuestions: Int = 3,
    /** How deep splits can nest. */
    val maxRecoveryDepth: Int = 2,
    /** Layer-0 retries plus layer-1 recovery calls per run. */
    val maxRecoveriesPerRun: Int = 4,
    /** Sub-tasks per split. */
    val maxSubTasks: Int = 5,
    /** Sub-task summary length in characters. */
    val recoverySummaryChars: Int = 500,
    /** Actions listed in the recovery brief. */
    val maxActionsInRecoveryBrief: Int = 20,
    /** Continuations per task. */
    val maxContinuations: Int = 2,
    /** Turn-limit questions per run. */
    val maxContinueQuestionsPerRun: Int = 4,
    /** Ask the user whether to continue a worker that hit its turn limit. */
    val askOnTurnLimit: Boolean = true,
    /** Wait for a turn-limit answer this long; [Duration.ZERO] waits forever. */
    val continueQuestionTimeout: Duration = 5.minutes,
    /** Worker turn ceiling; mirrors StewartSettings.maxWorkerTurnsCeiling. */
    val maxWorkerTurnsCeiling: Int = 60,
)

sealed interface OrchestrationResult {
    val messages: List<ChatMessage>
    val replans: List<String>
    val usage: Usage?
    data class Completed(
        override val messages: List<ChatMessage>,
        override val replans: List<String>,
        override val usage: Usage?,
    ) : OrchestrationResult
    data class Failed(
        override val messages: List<ChatMessage>,
        override val replans: List<String>,
        val message: String,
        override val usage: Usage?,
        val code: String? = null,
    ) : OrchestrationResult
}

object ProtocolTools {
    private fun objSchema(props: List<Pair<String, JsonObject>>, required: List<String>) =
        buildJsonObject {
            put("type", JsonPrimitive("object"))
            put("properties", buildJsonObject { props.forEach { (k, v) -> put(k, v) } })
            put("required", JsonArray(required.map { JsonPrimitive(it) }))
            put("additionalProperties", JsonPrimitive(false))
        }

    private fun str() = JsonObject(mapOf("type" to JsonPrimitive("string")))
    private fun intType() = JsonObject(mapOf("type" to JsonPrimitive("integer")))

    private fun reject(message: String): Nothing = throw ProtocolException(message)

    private fun <T> protocolTool(
        name: String,
        description: String,
        schema: JsonObject,
        parse: (JsonObject) -> T,
    ) = ProtocolTool(ToolSpec(name, description, schema), parse)

    fun planTool(startId: Int, maxMilestones: Int, turnCeiling: Int = Int.MAX_VALUE) = protocolTool(
        Protocol.SUBMIT_PLAN,
        "Submit the full plan: goal plus ordered, independently checkable milestones. A milestone may carry turn_budget (suggested Worker turns per task) when its tasks will be large.",
        objSchema(
            listOf(
                "goal" to str(),
                "milestones" to JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("array"),
                        "items" to objSchema(
                            listOf(
                                "id" to intType(),
                                "title" to str(),
                                "notes" to str(),
                                "turn_budget" to JsonObject(
                                    mapOf(
                                        "type" to JsonPrimitive("integer"),
                                        "description" to JsonPrimitive(
                                            "Optional suggested Worker turns per task in this milestone; raise it for large milestones. Must be between 1 and the global ceiling; out-of-range values are rejected."
                                        ),
                                    )
                                ),
                            ),
                            listOf("id", "title"),
                        ),
                    )
                ),
            ),
            listOf("goal", "milestones"),
        ),
        { args -> parsePlan(args, startId, turnCeiling).also { planError(it, maxMilestones)?.let(::reject) } }
    )

    fun tasksTool(maxTasksPerRound: Int, turnCeiling: Int = Int.MAX_VALUE) = protocolTool(
        Protocol.SUBMIT_TASKS,
        "Dispatch concrete tasks to the Worker. Each task must be finishable by one Worker alone. Set max_turns on a task you expect to need more Worker turns than the default.",
        objSchema(
            listOf(
                "tasks" to JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("array"),
                        "items" to objSchema(
                            listOf(
                                "id" to intType(),
                                "description" to str(),
                                "files" to JsonObject(
                                    mapOf("type" to JsonPrimitive("array"), "items" to str())
                                ),
                                "depends_on" to JsonObject(
                                    mapOf("type" to JsonPrimitive("array"), "items" to intType())
                                ),
                                "max_turns" to JsonObject(
                                    mapOf(
                                        "type" to JsonPrimitive("integer"),
                                        "description" to JsonPrimitive(
                                            "Optional Worker turn limit for this task; raise it for tasks you expect to be large. Must be between 1 and the global ceiling; out-of-range values are rejected."
                                        ),
                                    )
                                ),
                            ),
                            listOf("id", "description"),
                        ),
                    )
                ),
            ),
            listOf("tasks"),
        ),
        { args -> parseTasks(args, turnCeiling).also { tasksError(it, maxTasksPerRound)?.let(::reject) } }
    )

    fun completeMilestoneTool() = protocolTool(
        Protocol.COMPLETE_MILESTONE,
        "Declare the current milestone complete.",
        objSchema(listOf("notes" to str()), emptyList()),
        { args -> args["notes"]?.jsonPrimitive?.content.orEmpty() }
    )

    fun resultTool(expectedTaskId: Int) = protocolTool(
        Protocol.SUBMIT_RESULT,
        "Report the outcome of the given task.",
        objSchema(
            listOf(
                "task_id" to intType(),
                "status" to JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("string"),
                        "enum" to buildJsonArray {
                            add(JsonPrimitive("done")); add(JsonPrimitive("failed"))
                        },
                    )
                ),
                "summary" to str(),
            ),
            listOf("task_id", "status", "summary"),
        ),
        { args -> parseResult(args, expectedTaskId) }
    )
}

internal sealed interface LevelStatus {
    data object Completed : LevelStatus
    data object TurnLimit : LevelStatus
    data class Failed(val message: String, val code: String?) : LevelStatus
}

internal data class LevelRun(
    val messages: List<ChatMessage>,
    val usage: Usage?,
    val status: LevelStatus,
    val submitted: ToolCall? = null,
    val role: AgentRole? = null,
    /** Set when a layer-1 split ran the task as sub-tasks; stands in for the worker's own result. */
    val merged: WorkerResult? = null,
    /** Why a layer-1 recovery did not happen or failed; appended to the failure message. */
    val note: String? = null,
)

class Orchestrator(
    private val routes: Map<AgentRole, LevelRoute>,
    private val projectTools: () -> ToolRegistry,
    private val approval: ApprovalGate,
    private val limits: OrchestratorLimits = OrchestratorLimits(),
    private val compactor: ContextCompactor = ContextCompactor(),
    private val compactAtTokens: Int? = null,
    private val prompter: UserPrompter? = null,
    private val clock: () -> java.time.LocalDateTime = { java.time.LocalDateTime.now() },
    private val random: kotlin.random.Random = kotlin.random.Random.Default,
    /** Scratch space for layer-1 splits; null disables splitting. */
    private val scratch: Scratch? = null,
    /** Days to keep old scratch run dirs (the debug-log retention); 0 keeps everything. */
    private val scratchRetentionDays: Int = 0,
    /** Sink for recovery decisions; lines already carry the run id. Defaults to the debug log. */
    private val recoveryLog: (String) -> Unit = { DebugLogSink.log("recovery", "orchestrator", "-", it) },
) {

    private fun logRecovery(message: String) {
        try {
            recoveryLog("[run $runId] $message")
        } catch (_: Exception) {
        }
    }

    /** The unrecovered fault of the milestone in progress, and what was tried; reset per milestone. */
    private var lastFault: RecoverableFault? = null
    private val attempts = mutableListOf<String>()

    private fun faultNote(): FaultNote? =
        lastFault?.let { FaultNote(it.kind, it.message, attempts.toList()) }

    private fun describeFault(n: FaultNote): String =
        "fault: ${n.kind.name.lowercase()} (${n.message}); recovery: " +
            (if (n.recoveryAttempts.isEmpty()) "none" else n.recoveryAttempts.joinToString(", "))

    /** Tool-call approval for levels: scratch-dir writes of the live run are auto-approved. */
    private val workerApproval: ApprovalGate =
        scratch?.let { ScratchApprovalGate(approval, it) { runId } } ?: approval

    /** Id of the current (or most recent) run: `yyyyMMdd-HHmmss-<4 hex>`; for scratch paths and log tags. */
    @Volatile
    var runId: String = ""
        private set

    private fun newRunId(): String =
        RUN_ID_FORMAT.format(clock()) + "-" + "%04x".format(random.nextInt(0x10000))

    /** Runs the plan; cancellation surfaces as [RunCancelledException] carrying the transcript so far. */
    suspend fun run(
        request: String,
        listener: OrchestratorListener,
        history: List<ChatMessage> = emptyList(),
        images: List<ImageAttachment> = emptyList(),
    ): OrchestrationResult {
        val transcript = mutableListOf<ChatMessage>()
        runId = newRunId()
        recoveries = 0
        continueQuestions = 0
        lastFault = null
        lastFailureCode = null
        attempts.clear()
        scratch?.let { sc ->
            if (scratchRetentionDays > 0) {
                try {
                    val n = sc.prune(scratchRetentionDays, currentRunId = runId)
                    if (n > 0) logRecovery("pruned $n old scratch run dir(s)")
                } catch (e: Exception) {
                    logRecovery("scratch prune failed: ${e.message}")
                }
            }
        }
        val result = try {
            runSteps(request, listener, history, transcript, images)
        } catch (e: CancellationException) {
            val partial = (e as? RunCancelledException)?.produced ?: emptyList()
            throw RunCancelledException(emptyList(), transcript + partial, e, runUsage)
        }
        if (result is OrchestrationResult.Completed) {
            // Everything the user needs is in final_file; drop the run's scratch, kept dirs of obsolete splits included.
            try {
                scratch?.deleteRun(runId)
            } catch (e: Exception) {
                logRecovery("scratch cleanup failed: ${e.message}")
            }
        }
        return if (result is OrchestrationResult.Failed && result.code == null) result.copy(code = lastFailureCode) else result
    }

    /** Code of the most recent failed level, so a run failure keeps its provider error code. */
    private var lastFailureCode: String? = null

    /** Layer-0 retries used in the current run; bounded by [OrchestratorLimits.maxRecoveriesPerRun]. */
    private var recoveries = 0

    /** Turn-limit questions asked in the current run; separate from the Planner's question budget. */
    private var continueQuestions = 0

    /** Usage of every level run so far (including a cancelled one), for the cancellation report. */
    private var runUsage: Usage? = null

    private suspend fun runSteps(
        request: String,
        listener: OrchestratorListener,
        history: List<ChatMessage>,
        transcript: MutableList<ChatMessage>,
        images: List<ImageAttachment> = emptyList(),
    ): OrchestrationResult {
        val replans = mutableListOf<String>()
        var lastNote: FaultNote? = null
        var usage: Usage? = null

        // One tool for the whole run so the question budget spans the plan and every re-plan.
        val askTool = prompter?.let { AskUserTool(it, limits.maxQuestions, listener::onQuestion) }
        val planTool = ProtocolTools.planTool(1, limits.maxMilestones, limits.maxWorkerTurnsCeiling)
        val planRes = runLevel(
            AgentRole.PLANNER, "plan",
            RolePrompts.forRole(AgentRole.PLANNER) + " " + Protocol.PLANNER + askHint(askTool),
            listOfNotNull(planTool, askTool),
            setOf(Protocol.SUBMIT_PLAN),
            request,
            history,
            listener,
            images,
        )
        usage = sumUsage(usage, planRes.usage)
        transcript += planRes.messages
        val plan = planTool.accepted ?: return OrchestrationResult.Failed(
            transcript, replans, "Planner: ${failureMessage(planRes)}" + scratchSuffix(), usage, failureCode(planRes)
        )
        var lastCode: String? = null
        var currentPlan = plan
        listener.onPlan(currentPlan)

        val finished = mutableListOf<Pair<Milestone, String>>()
        var start = 0
        outer@ while (true) {
            for (i in start until currentPlan.milestones.size) {
                val milestone = currentPlan.milestones[i]
                lastCode = null
                lastFault = null
                attempts.clear()
                val results = mutableListOf<WorkerResult>()
                var round = 0
                var execBase = emptyList<ChatMessage>()
                var lastTaskCount: Int? = null
                var done = false
                while (!done) {
                    round++
                    if (round > limits.maxTaskRounds) {
                        lastNote = milestoneFailed(
                            transcript, replans, listener,
                            "milestone '${milestone.title}' (${milestone.id}) not met after ${limits.maxTaskRounds} task rounds",
                        )
                        break
                    }
                    // A fault belongs to the round that hit it; do not blame a later, unrelated failure on it.
                    lastFault = null
                    attempts.clear()
                    val content = buildString {
                        append("Goal: ${currentPlan.goal}\n")
                        append("Milestone ${milestone.id}: ${milestone.title}\n")
                        if (milestone.notes.isNotBlank()) append("Definition of done: ${milestone.notes}\n")
                        milestone.turnBudget?.let { append("Suggested worker turns: $it\n") }
                        if (results.isNotEmpty()) {
                            append("Worker results from previous round:\n")
                            results.forEach { r ->
                                append("- task ${r.taskId} [${r.status}]: ${bound(r.summary)}\n")
                            }
                        }
                        append(
                            if (round == 1) "\nBreak this milestone into concrete tasks and dispatch them."
                            else "\nReview the worker results above: complete the milestone, or dispatch corrected tasks."
                        )
                    }
                    val tasksTool = ProtocolTools.tasksTool(limits.maxTasksPerRound, limits.maxWorkerTurnsCeiling)
                    val completeTool = ProtocolTools.completeMilestoneTool()
                    val res = runLevel(
                        AgentRole.EXECUTOR,
                        "milestone '${milestone.title}' (${milestone.id}), round $round",
                        RolePrompts.forRole(AgentRole.EXECUTOR) + " " + Protocol.EXECUTOR,
                        listOf(tasksTool, completeTool),
                        setOf(Protocol.SUBMIT_TASKS, Protocol.COMPLETE_MILESTONE),
                        content,
                        execBase,
                        listener,
                        previousCount = lastTaskCount,
                    )
                    usage = sumUsage(usage, res.usage)
                    transcript += res.messages
                    val call = res.submitted
                    if (call == null) {
                        lastCode = failureCode(res)
                        lastNote = milestoneFailed(
                            transcript, replans, listener,
                            "milestone '${milestone.title}' (${milestone.id}): ${failureMessage(res)}",
                        )
                        break
                    }
                    execBase = execBase + ChatMessage(Role.USER, content) + res.messages
                    if (call.name == Protocol.COMPLETE_MILESTONE) {
                        finished += milestone to bound(completeTool.accepted.orEmpty())
                        done = true
                    } else {
                        val tasks = checkNotNull(tasksTool.accepted) { "submit_tasks succeeded without a task list" }
                        listener.onTasks(round, tasks)
                        lastTaskCount = tasks.size
                        val workerUsage = runTasksSerially(
                            currentPlan.goal, milestone, tasks, results, transcript, listener
                        )
                        usage = sumUsage(usage, workerUsage)
                    }
                }
                if (!done) {
                    if (replans.size >= limits.maxReplans) {
                        return OrchestrationResult.Failed(
                            transcript, replans, exhaustedMessage(replans.last(), lastNote), usage, lastCode
                        )
                    }
                    val (replanned, newPlan) = replan(currentPlan, milestone, replans.last(), lastNote, transcript, listener, askTool)
                    usage = sumUsage(usage, replanned.usage)
                    if (newPlan == null) {
                        return OrchestrationResult.Failed(
                            transcript, replans, "re-plan failed: ${failureMessage(replanned)}" + scratchSuffix(), usage, failureCode(replanned)
                        )
                    }
                    // The re-plan re-covers the failed milestone and everything after it,
                    // so the run resumes at the start of the new plan.
                    currentPlan = newPlan
                    start = 0
                    continue@outer
                }
            }
            break
        }

        val summary = buildString {
            append("Done. Goal: ${currentPlan.goal}\n")
            finished.forEach { (m, notes) ->
                append("- [${m.id}] ${m.title}: ${if (notes.isNotBlank()) notes else "done"}\n")
            }
        }
        transcript += ChatMessage(Role.ASSISTANT, summary)
        listener.onDelta(summary)
        listener.onCompleted(usage)
        return OrchestrationResult.Completed(transcript, replans, usage)
    }

    /** Runs one milestone's failed path: records the reason and asks the Planner to re-plan. */
    private suspend fun replan(
        plan: Plan,
        milestone: Milestone,
        reason: String,
        fault: FaultNote?,
        transcript: MutableList<ChatMessage>,
        listener: OrchestratorListener,
        askTool: AskUserTool?,
    ): Pair<LevelRun, Plan?> {
        val planTool = ProtocolTools.planTool(milestone.id, limits.maxMilestones, limits.maxWorkerTurnsCeiling)
        val content = buildString {
            append("Goal: ${plan.goal}\n")
            append("Milestone ${milestone.id}: ${milestone.title} could not be completed.\n")
            append("Reason: $reason\n")
            fault?.let {
                append("Fault: ${it.kind.name.lowercase()} (${it.message})\n")
                append("Recovery attempted: ${if (it.recoveryAttempts.isEmpty()) "none" else it.recoveryAttempts.joinToString("; ")}\n")
            }
            append(
                "Milestones after ${milestone.id} are still: " +
                    plan.milestones.filter { it.id > milestone.id }.joinToString { it.title } + "\n"
            )
        }
        val res = runLevel(
            AgentRole.PLANNER, "re-plan",
            RolePrompts.forRole(AgentRole.PLANNER) + " " +
                Protocol.REPLAN.replace("\$NEXT_ID", milestone.id.toString()) + " " + Protocol.SIZE_RULE + askHint(askTool),
            listOfNotNull(planTool, askTool),
            setOf(Protocol.SUBMIT_PLAN),
            content,
            emptyList(),
            listener,
            previousCount = plan.milestones.size,
        )
        transcript.addAll(res.messages)
        return res to planTool.accepted
    }

    private fun milestoneFailed(
        transcript: MutableList<ChatMessage>,
        replans: MutableList<String>,
        listener: OrchestratorListener,
        reason: String,
    ): FaultNote? {
        replans += reason
        listener.onReplanning(reason)
        transcript.add(ChatMessage(Role.SYSTEM, "Re-planning: $reason"))
        val note = faultNote()
        if (note != null) logRecovery("milestone failed after recovery: ${describeFault(note)}")
        return note
    }

    /** Final failure text: reason, then the fault and recovery attempts, then the kept scratch dir if any. */
    private fun exhaustedMessage(reason: String, note: FaultNote?): String = buildString {
        append("re-planning budget exhausted: $reason")
        note?.let { append("; ").append(describeFault(it)) }
        append(scratchSuffix())
    }

    /** "; scratch: <dir>" when this run kept a scratch dir, else empty. */
    private fun scratchSuffix(): String {
        val dir = scratch?.runDir(runId)
        return if (dir != null && runId.isNotEmpty() && java.nio.file.Files.isDirectory(dir)) "; scratch: $dir" else ""
    }

    /** Dispatches workers strictly one at a time so their edits cannot conflict. */
    private suspend fun runTasksSerially(
        goal: String,
        milestone: Milestone,
        tasks: List<DispatchTask>,
        results: MutableList<WorkerResult>,
        transcript: MutableList<ChatMessage>,
        listener: OrchestratorListener,
    ): Usage? {
        var usage: Usage? = null
        val roundResults = mutableListOf<WorkerResult>()
        for (task in tasks) {
            val content = workerBriefing(
                goal, milestone, task,
                roundResults.filter { it.taskId in task.dependsOn },
                limits.maxHandoffChars,
            )
            val resultTool = ProtocolTools.resultTool(task.id)
            val res = runLevel(
                AgentRole.WORKER,
                "milestone '${milestone.title}' (${milestone.id}), task ${task.id}: ${task.description}",
                RolePrompts.forRole(AgentRole.WORKER) + " " + Protocol.WORKER,
                projectTools().tools + resultTool,
                setOf(Protocol.SUBMIT_RESULT),
                content,
                emptyList(),
                listener,
                maxTurns = workerTurns(task, milestone),
                continuation = ContinueSpec(task.id, task.description, goal, milestone),
            )
            usage = sumUsage(usage, res.usage)
            transcript += res.messages
            val result = workerResult(res, resultTool, task.id)
            results += result
            roundResults += result
            listener.onResult(result)
        }
        return usage
    }

    /**
     * [runLevelOnce] plus layer-0 recovery (see FaultRecovery.kt): one retry of a transient
     * [FaultKind.INCOMPLETE_STREAM] at any level, or of a size fault at Planner/Executor with a size
     * hint. [previousCount] is the previous submission's task/milestone count, if known. Retries
     * draw on [OrchestratorLimits.maxRecoveriesPerRun], never on the replan budget.
     */
    private suspend fun runLevel(
        role: AgentRole,
        context: String,
        system: String,
        tools: List<Tool>,
        terminal: Set<String>,
        userContent: String,
        baseHistory: List<ChatMessage>,
        listener: OrchestratorListener,
        images: List<ImageAttachment> = emptyList(),
        maxTurns: Int = limits.maxLevelModelTurns,
        previousCount: Int? = null,
        continuation: ContinueSpec? = null,
    ): LevelRun {
        // Per task, across layer-0 retries: a retry must not reset the continuation cap.
        val continuationsUsed = IntArray(1)
        val first = runLevelOnce(role, context, system, tools, terminal, userContent, baseHistory, listener, images, maxTurns, continuation, continuationsUsed)
        val fault = classify(first)
        if (fault == null) {
            // A split started from inside the level loop (turn limit) that failed: remember the fault.
            if (first.merged != null && first.merged.status != "done") {
                lastFault = RecoverableFault(FaultKind.TURN_LIMIT, role, "turn limit reached")
            }
            return first
        }
        if (role == AgentRole.WORKER && fault.kind == FaultKind.TRUNCATED && continuation != null) {
            val rec = recoverBySplit(continuation, fault, first, listener)
            if (rec.merged?.status != "done") lastFault = fault
            return rec
        }
        if (recoveries >= limits.maxRecoveriesPerRun) {
            lastFault = fault
            return first
        }
        val content = when (fault.kind) {
            FaultKind.INCOMPLETE_STREAM -> userContent
            FaultKind.TRUNCATED, FaultKind.TURN_LIMIT ->
                if (role == AgentRole.WORKER) {
                    lastFault = fault
                    return first
                } else userContent + "\n\n" + sizeHint(previousCount)
        }
        recoveries++
        attempts += "retried ${role.name.lowercase()} after ${fault.kind.name.lowercase()}"
        logRecovery("layer 0: ${fault.kind} at ${role.name.lowercase()} (${fault.message}); retrying")
        listener.onRecovering(
            fault.kind,
            if (fault.kind == FaultKind.INCOMPLETE_STREAM) "Stream dropped, retrying…" else "Output limit hit, retrying…",
            continuation?.depth ?: 0,
        )
        val retry = runLevelOnce(role, "$context (retry)", system, tools, terminal, content, baseHistory, listener, images, maxTurns, continuation, continuationsUsed)
        classify(retry)?.let { lastFault = it }
        logRecovery("layer 0 retry of ${role.name.lowercase()}: ${if (classify(retry) == null) "ok" else "faulted again"}")
        return retry.copy(usage = sumUsage(first.usage, retry.usage))
    }

    /** Identifies the task a worker is running, for the turn-limit question. */
    internal data class ContinueSpec(
        val taskId: Int,
        val description: String,
        val goal: String,
        val milestone: Milestone,
        /** 0 for a planned task, +1 per nested split. */
        val depth: Int = 0,
        /** Where a split of this task puts its scratch files; null for a top-level task (its own task dir). */
        val splitDir: java.nio.file.Path? = null,
        /** For a sub-task: the file its output must end up in, so a nested split joins into it. */
        val outputPath: java.nio.file.Path? = null,
    )

    internal sealed interface TurnLimitDecision {
        /** Resume the worker; [text] is user free text appended before resuming. */
        data class Continue(val text: String? = null) : TurnLimitDecision
        data object Split : TurnLimitDecision
        /** Could not ask and could not split: today's turn-limit failure. */
        data object Stop : TurnLimitDecision
        /** The user chose to stop. */
        data object StoppedByUser : TurnLimitDecision
    }

    private val recoverySystem =
        "You are the Planner recovering from a failed Worker task. Protocol: call $SUBMIT_RECOVERY exactly once with " +
            "{\"subtasks\": [{\"description\": \"<one smaller task>\", \"output_file\": \"<bare file name>\", \"max_turns\": <optional integer>}], " +
            "\"final_file\": \"<optional project path the outputs are joined into>\", \"advice\": \"<optional hint for the workers>\"}. " +
            "You have no other tools."

    /**
     * Layer 1: splits a faulted worker task into sub-tasks (see SplitRecovery.kt). Returns a run carrying
     * [LevelRun.merged] when the split ran (done or failed); otherwise [run] with a [LevelRun.note] saying
     * why not, so the caller falls back to the worker-failed path. Without scratch space it returns [run].
     */
    private suspend fun recoverBySplit(
        spec: ContinueSpec,
        fault: RecoverableFault,
        run: LevelRun,
        listener: OrchestratorListener,
    ): LevelRun {
        val scratch = scratch ?: return run
        fun skipped(why: String): LevelRun {
            attempts += "split skipped: $why"
            logRecovery("layer 1: split of task ${spec.taskId} skipped: $why")
            return run.copy(note = why)
        }
        if (spec.depth >= limits.maxRecoveryDepth) return skipped("depth limit ${limits.maxRecoveryDepth} reached")
        if (recoveries >= limits.maxRecoveriesPerRun) return skipped("recovery budget exhausted")
        recoveries++
        attempts += "split task ${spec.taskId}"
        logRecovery("layer 1: ${fault.kind} on task ${spec.taskId} (depth ${spec.depth}); asking for a split")
        listener.onRecovering(
            fault.kind,
            if (fault.kind == FaultKind.TRUNCATED) "Output limit hit, splitting task…" else "Turn limit hit, splitting task…",
            spec.depth,
        )
        var usage = run.usage
        val taskDir = spec.splitDir ?: scratch.taskDir(runId, spec.milestone.id, spec.taskId)
        val existing = try {
            java.nio.file.Files.list(taskDir).use { st -> st.map { it.fileName.toString() }.sorted().toList() }
        } catch (_: java.io.IOException) {
            emptyList()
        }
        val brief = SplitRecovery.buildBrief(
            DispatchTask(spec.taskId, spec.description), fault, recoveryActions(run.messages), existing, limits,
            spec.milestone.notes,
        )
        val tool = SplitRecovery.recoveryTool(limits)
        val rec = runLevelOnce(
            AgentRole.PLANNER, "recovery for task ${spec.taskId}", recoverySystem,
            listOf(tool), setOf(SUBMIT_RECOVERY), brief, emptyList(), listener,
        )
        usage = sumUsage(usage, rec.usage)
        val plan = tool.accepted
            ?: return run.copy(usage = usage, note = "no valid $SUBMIT_RECOVERY: ${failureMessage(rec)}").also {
                attempts += "split failed: no valid plan"
                logRecovery("layer 1: no valid $SUBMIT_RECOVERY for task ${spec.taskId}")
            }
        val dir = if (spec.splitDir != null) java.nio.file.Files.createDirectories(spec.splitDir)
        else scratch.create(runId, spec.milestone.id, spec.taskId)
        // Whatever ends this split (cancel, assembly failure, rejection), the task dir stops being auto-approved.
        var closed = false
        try {
            val target = spec.outputPath?.toString() ?: plan.finalFile
            val shown = plan.copy(finalFile = target)

            val results = mutableListOf<WorkerResult>()
            for ((i, st) in plan.subtasks.withIndex()) {
                val sub = DispatchTask(spec.taskId, st.description, maxTurns = st.maxTurns)
                val out = dir.resolve(st.outputFile)
                val content = buildString {
                    append(workerBriefing(spec.goal, spec.milestone, sub, emptyList(), limits.maxHandoffChars))
                    append("\nWrite your full output to `$out` with WriteFile. Then call ${Protocol.SUBMIT_RESULT} with task_id = ${spec.taskId} ")
                    append("and a summary of at most ${limits.recoverySummaryChars} characters.")
                    results.forEachIndexed { j, r ->
                        append("\nEarlier sub-task ${j + 1} [${r.status}]: ${r.summary.take(limits.recoverySummaryChars)} (file: ${dir.resolve(plan.subtasks[j].outputFile)})")
                    }
                    plan.advice?.let { append("\nAdvice: $it") }
                }
                val resultTool = ProtocolTools.resultTool(spec.taskId)
                val res = runLevel(
                    AgentRole.WORKER,
                    "milestone '${spec.milestone.title}' (${spec.milestone.id}), task ${spec.taskId} part ${i + 1}/${plan.subtasks.size}: ${st.description}",
                    RolePrompts.forRole(AgentRole.WORKER) + " " + Protocol.WORKER,
                    projectTools().tools + resultTool,
                    setOf(Protocol.SUBMIT_RESULT),
                    content,
                    emptyList(),
                    listener,
                    maxTurns = workerTurns(sub, spec.milestone),
                    continuation = spec.copy(
                        description = st.description, depth = spec.depth + 1,
                        splitDir = dir.resolve("split-$i"), outputPath = out,
                    ),
                )
                usage = sumUsage(usage, res.usage)
                val result = workerResult(res, resultTool, spec.taskId)
                results += result
                if (result.status != "done") break
            }

            if (target != null && results.size == plan.subtasks.size && results.all { it.status == "done" }) {
                try {
                    val outputs = plan.subtasks.mapNotNull { st ->
                        val f = dir.resolve(st.outputFile)
                        if (java.nio.file.Files.isRegularFile(f)) st.outputFile to java.nio.file.Files.readString(f) else null
                    }.toMap()
                    writeJoined(target, SplitRecovery.joinOutputs(plan, outputs))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    attempts += "split failed: assembly"
                    logRecovery("layer 1: assembly into $target failed: ${e.message}")
                    return run.copy(usage = usage, note = "assembly failed: ${e.message}; scratch: $dir")
                }
            }
            var merged = SplitRecovery.mergeResults(
                spec.taskId, shown, results, limits.recoverySummaryChars, limits.maxHandoffChars,
            )
            val success = merged.status == "done"
            closed = true
            val kept = if (spec.splitDir == null) scratch.finish(dir, success) else if (success) null else dir
            if (kept != null) merged = merged.copy(summary = merged.summary + "\nscratch kept: $kept")
            attempts += "split task ${spec.taskId} into ${plan.subtasks.size} sub-tasks: ${merged.status}"
            logRecovery(
                "layer 1: split of task ${spec.taskId} into ${plan.subtasks.size} sub-tasks " +
                    "(${results.size} run, final_file=${target ?: "none"}): ${merged.status}" + (kept?.let { "; scratch kept: $it" } ?: ""),
            )
            return LevelRun(run.messages, usage, LevelStatus.Completed, role = AgentRole.WORKER, merged = merged)
        } finally {
            if (!closed && spec.splitDir == null) scratch.finish(dir, false)
        }
    }

    /** Writes the joined sub-task outputs through the WriteFile tool and the approval gate. */
    private suspend fun writeJoined(path: String, content: String) {
        val tool = projectTools().find("WriteFile") ?: throw RecoveryAssemblyException("WriteFile tool unavailable")
        val args = buildJsonObject { put("path", path); put("content", content) }
        val preview = tool.preview(args)
        when (val d = workerApproval.review(ToolCall("recovery-final", "WriteFile", args), preview)) {
            is ApprovalDecision.Rejected -> throw RecoveryAssemblyException("write to $path rejected: ${d.reason}")
            ApprovalDecision.Approved -> tool.execute(args, preview)
        }
    }

    /** True when a layer-1 split of [spec] can run: scratch set, depth and recovery budget allow it. */
    private fun canSplit(spec: ContinueSpec): Boolean =
        scratch != null && spec.depth < limits.maxRecoveryDepth && recoveries < limits.maxRecoveriesPerRun

    /**
     * Asks whether to continue a worker at its turn limit. When the question may not or cannot be asked
     * it goes straight to Split if a split is possible, else Stop. Split is only offered when possible.
     */
    private suspend fun askToContinue(
        spec: ContinueSpec,
        messages: List<ChatMessage>,
        turns: Int,
        continuationsUsed: Int,
        listener: OrchestratorListener,
    ): TurnLimitDecision {
        val ask = prompter
        val split = canSplit(spec)
        val noSplit = if (split) TurnLimitDecision.Split else TurnLimitDecision.Stop
        if (ask == null || !limits.askOnTurnLimit ||
            continuationsUsed >= limits.maxContinuations ||
            continueQuestions >= limits.maxContinueQuestionsPerRun
        ) return noSplit
        continueQuestions++
        val stuck = detectStuck(messages)
        val options = continueOptions(stuck != null, turns, withSplit = split)
        val question = continueQuestionText(turns, spec.taskId.toString(), spec.description, messages, stuck, turns)
        listener.onQuestion(question, options)
        val timeout = limits.continueQuestionTimeout
        val answer = if (timeout <= Duration.ZERO) ask.ask(question, options)
        else withTimeoutOrNull(timeout) { ask.ask(question, options) }
        if (answer == null) {
            logRecovery("turn limit question on task ${spec.taskId}: timed out" + if (split) ", splitting" else "")
            listener.onQuestionWithdrawn()
            return noSplit
        }
        val text = answer.trim()
        val matched = options.firstOrNull { it.equals(text, ignoreCase = true) }
        logRecovery("turn limit question on task ${spec.taskId}: answer=${matched ?: if (text.isEmpty()) "blank" else "free text"}")
        return when {
            matched == null && text.isEmpty() -> TurnLimitDecision.StoppedByUser
            matched == null -> TurnLimitDecision.Continue(text)
            matched.startsWith("Continue") -> TurnLimitDecision.Continue()
            matched.startsWith("Split") && split -> TurnLimitDecision.Split
            else -> TurnLimitDecision.StoppedByUser
        }
    }

    private fun sizeHint(previousCount: Int?): String {
        val n = if (previousCount != null) "at most ${(previousCount + 1) / 2}" else "fewer"
        return "Your previous reply hit the output limit. Submit $n tasks (or milestones), " +
            "keep each description under 300 chars, and put large data in files."
    }

    private suspend fun runLevelOnce(
        role: AgentRole,
        context: String,
        system: String,
        tools: List<Tool>,
        terminal: Set<String>,
        userContent: String,
        baseHistory: List<ChatMessage>,
        listener: OrchestratorListener,
        images: List<ImageAttachment> = emptyList(),
        maxTurns: Int = limits.maxLevelModelTurns,
        continuation: ContinueSpec? = null,
        continuationsUsed: IntArray = IntArray(1),
    ): LevelRun {
        val route = routes.getValue(role)
        lastFailureCode = null
        listener.onLevelRouted(role, route.label)
        listener.onLevelStarted(role, context)
        val loopListener = object : LoopListener {
            override fun onText(text: String) = listener.onDelta(text)
        }
        val loop = ToolLoop(
            route.provider,
            ToolRegistry(tools),
            workerApproval,
            LoopLimits(
                maxModelTurns = maxTurns,
                toolTimeout = limits.toolTimeout,
                compactAtTokens = compactAtTokens,
            ),
            compactor,
            rolePrompt = system,
            terminalTools = terminal,
        )
        // The role/protocol prompt is injected per request via rolePrompt, so it is
        // never duplicated in history and survives compaction re-injected each turn.
        val base = baseHistory +
            ChatMessage(Role.USER, userContent, images = images)
        suspend fun runLoop(history: List<ChatMessage>): LoopResult {
            val r = try {
                loop.run(route.ref.modelId, history, loopListener)
            } catch (e: RunCancelledException) {
                runUsage = sumUsage(runUsage, e.usage)
                throw e
            }
            runUsage = sumUsage(runUsage, r.usage)
            return r
        }
        // Messages of finished segments: a cancel anywhere below must keep them (plus the in-flight segment's).
        var allMessages: List<ChatMessage> = emptyList()
        var totalUsage: Usage? = null
        var note: String? = null
        var result: LoopResult
        try {
            result = runLoop(base)
            allMessages = result.messages
            totalUsage = result.usage
            while (result is LoopResult.TurnLimitReached && continuation != null) {
                val decision = askToContinue(continuation, allMessages, maxTurns, continuationsUsed[0], listener)
                if (decision is TurnLimitDecision.StoppedByUser) {
                    val stopped = WorkerResult(continuation.taskId, "failed", "stopped by user at turn limit")
                    return LevelRun(allMessages, totalUsage, LevelStatus.TurnLimit, role = role, merged = stopped)
                }
                if (decision is TurnLimitDecision.Split) {
                    val pre = LevelRun(allMessages, totalUsage, LevelStatus.TurnLimit, role = role)
                    val rec = recoverBySplit(
                        continuation, RecoverableFault(FaultKind.TURN_LIMIT, role, "turn limit reached"), pre, listener,
                    )
                    if (rec.merged != null) return rec
                    totalUsage = rec.usage
                    note = rec.note
                }
                if (decision !is TurnLimitDecision.Continue) break
                continuationsUsed[0]++
                attempts += "continued task ${continuation.taskId} (+$maxTurns turns)"
                logRecovery("continue: task ${continuation.taskId} +$maxTurns turns (#${continuationsUsed[0]})")
                listener.onRecovering(FaultKind.TURN_LIMIT, "Continuing task (+$maxTurns turns)…", continuation.depth)
                val added = decision.text?.let { listOf(ChatMessage(Role.USER, it)) } ?: emptyList()
                val history = result.base + result.messages + added
                allMessages = allMessages + added
                result = runLoop(history)
                allMessages = allMessages + result.messages
                totalUsage = sumUsage(totalUsage, result.usage)
            }
        } catch (e: CancellationException) {
            val rc = e as? RunCancelledException
            if (rc != null && allMessages.isEmpty()) throw e
            throw RunCancelledException(emptyList(), allMessages + rc?.produced.orEmpty(), e, rc?.usage)
        }
        val submitted = (result as? LoopResult.Completed)?.submitted
        val status = when (result) {
            is LoopResult.Completed ->
                if (submitted != null) LevelStatus.Completed
                else LevelStatus.Failed("${role.name.lowercase()} finished without submitting a structured result", null)
            is LoopResult.TurnLimitReached -> LevelStatus.TurnLimit
            is LoopResult.Failed -> {
                lastFailureCode = result.code
                LevelStatus.Failed("${route.label}: ${result.message}", result.code)
            }
        }
        return LevelRun(closeSkippedCalls(allMessages, submitted), totalUsage, status, submitted, role, note = note)
    }

    /**
     * A terminal call ends the level mid-turn (ToolLoop returns on it), so later calls of the same
     * turn have no result. Answer them so the history replayed to the next round, and saved to the
     * chat, stays a valid call/result sequence for every provider.
     */
    private fun closeSkippedCalls(messages: List<ChatMessage>, submitted: ToolCall?): List<ChatMessage> {
        if (submitted == null) return messages
        val turn = messages.indexOfLast { m -> m.toolCalls.any { it.id == submitted.id } }
        val answered = messages.drop(turn + 1).mapNotNull { it.toolCallId }.toSet()
        return messages + messages[turn].toolCalls.filter { it.id !in answered }.map {
            ChatMessage(Role.TOOL, "Not executed: ${submitted.name} already ended this level", toolCallId = it.id)
        }
    }

    /** Worker turn limit: task value, else milestone budget, else the level default; never above the ceiling. */
    internal fun workerTurns(task: DispatchTask, milestone: Milestone): Int =
        minOf(task.maxTurns ?: milestone.turnBudget ?: limits.maxLevelModelTurns, limits.maxWorkerTurnsCeiling)

    private fun askHint(askTool: AskUserTool?) = if (askTool != null) Protocol.ASK_USER_HINT else ""

    /** Caps text handed between levels so one verbose result cannot flood the next model. */
    private fun bound(text: String): String =
        if (text.length <= limits.maxHandoffChars) text
        else text.take(limits.maxHandoffChars) + "… [truncated ${text.length - limits.maxHandoffChars} chars]"

    private fun failureCode(res: LevelRun): String? = (res.status as? LevelStatus.Failed)?.code

    private fun failureMessage(res: LevelRun): String = when (val s = res.status) {
        is LevelStatus.Completed -> "no submission"
        is LevelStatus.TurnLimit -> "produced no structured result within the turn limit"
        is LevelStatus.Failed -> s.message
    } + (res.note?.let { "; recovery: $it" } ?: "")

    /** The worker's own submission, else a layer-1 merged result, else a failure naming why. */
    private fun workerResult(res: LevelRun, resultTool: ProtocolTool<WorkerResult>, taskId: Int): WorkerResult =
        resultTool.accepted ?: res.merged ?: WorkerResult(taskId, "failed", "no result submitted: ${failureMessage(res)}")

    private fun sumUsage(a: Usage?, b: Usage?): Usage? = when {
        a == null -> b
        b == null -> a
        else -> a + b
    }
}

// --- protocol parsing ---------------------------------------------------------

/**
 * An optional turn count: absent for non-integer values (null, string, fractional, non-primitive);
 * an integer outside 1..[ceiling] is rejected so the model can resubmit.
 */
private fun turnCount(el: kotlinx.serialization.json.JsonElement?, label: String, ceiling: Int): Int? {
    val prim = (el as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
    val n = prim.intOrNull
        ?: if (prim.content.matches(Regex("-?\\d+"))) {
            throw ProtocolException("$label must be between 1 and $ceiling (got ${prim.content})")
        } else return null
    if (n < 1 || n > ceiling) throw ProtocolException("$label must be between 1 and $ceiling (got $n)")
    return n
}

internal fun parsePlan(args: JsonObject, startId: Int = 1, turnCeiling: Int = Int.MAX_VALUE): Plan {
    val goal = args["goal"]?.jsonPrimitive?.content
    if (goal.isNullOrBlank()) throw ProtocolException("missing 'goal'")
    val milestonesEl = args["milestones"]
    if (milestonesEl !is JsonArray || milestonesEl.isEmpty()) {
        throw ProtocolException("'milestones' must be a non-empty array")
    }
    val seen = mutableSetOf<Int>()
    val milestones = milestonesEl.mapIndexed { index, el ->
        val obj = el as? JsonObject ?: throw ProtocolException("milestone $index is not an object")
        val id = obj["id"]?.jsonPrimitive?.intOrNull
            ?: throw ProtocolException("milestone $index missing integer 'id'")
        val title = obj["title"]?.jsonPrimitive?.content
        if (title.isNullOrBlank()) throw ProtocolException("milestone $id missing 'title'")
        if (!seen.add(id)) throw ProtocolException("duplicate milestone id $id")
        val notes = obj["notes"]?.jsonPrimitive?.content.orEmpty()
        Milestone(id, title, notes, turnCount(obj["turn_budget"], "milestone $id turn_budget", turnCeiling))
    }
    val expected = (startId..(startId + milestones.size - 1)).toList()
    if (milestones.map { it.id } != expected) {
        throw ProtocolException("milestone ids must be ${expected.first()}..${expected.last()} in order")
    }
    return Plan(goal, milestones)
}

internal fun parseTasks(args: JsonObject, turnCeiling: Int = Int.MAX_VALUE): List<DispatchTask> {
    val tasksEl = args["tasks"]
    if (tasksEl !is JsonArray) throw ProtocolException("'tasks' must be an array")
    val seen = mutableSetOf<Int>()
    val earlier = mutableSetOf<Int>()
    return tasksEl.mapIndexed { index, el ->
        val obj = el as? JsonObject ?: throw ProtocolException("task $index is not an object")
        val id = obj["id"]?.jsonPrimitive?.intOrNull
            ?: throw ProtocolException("task $index missing integer 'id'")
        val description = obj["description"]?.jsonPrimitive?.content
        if (description.isNullOrBlank()) throw ProtocolException("task $id missing 'description'")
        if (!seen.add(id)) throw ProtocolException("duplicate task id $id")
        val files = (obj["files"] ?: JsonNull).let { el ->
            when (el) {
                JsonNull -> emptyList()
                is JsonArray -> el.map { f ->
                    (f as? JsonPrimitive)?.takeIf { it.isString }?.content
                        ?: throw ProtocolException("task $id 'files' must contain only strings")
                }
                else -> throw ProtocolException("task $id 'files' must be an array")
            }
        }
        val dependsOn = (obj["depends_on"] ?: JsonNull).let { el ->
            when (el) {
                JsonNull -> emptyList()
                is JsonArray -> el.map { d ->
                    (d as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
                        ?: throw ProtocolException("task $id 'depends_on' must contain only integer ids")
                }
                else -> throw ProtocolException("task $id 'depends_on' must be an array")
            }
        }
        dependsOn.forEach { d ->
            if (d !in earlier) throw ProtocolException("task $id depends_on $d, which is not an earlier task in this round")
        }
        earlier += id
        DispatchTask(id, description, files, dependsOn, turnCount(obj["max_turns"], "task $id max_turns", turnCeiling))
    }
}

internal fun parseResult(args: JsonObject, expectedTaskId: Int): WorkerResult {
    val taskId = args["task_id"]?.jsonPrimitive?.intOrNull
        ?: throw ProtocolException("missing integer 'task_id'")
    if (taskId != expectedTaskId) {
        throw ProtocolException("task_id $taskId does not match dispatched task $expectedTaskId")
    }
    val status = args["status"]?.jsonPrimitive?.content
        ?: throw ProtocolException("missing 'status'")
    if (status !in listOf("done", "failed")) throw ProtocolException("status must be 'done' or 'failed'")
    val summary = args["summary"]?.jsonPrimitive?.content
    if (summary.isNullOrBlank()) throw ProtocolException("missing 'summary'")
    return WorkerResult(taskId, status, summary)
}

internal fun planError(plan: Plan, maxMilestones: Int): String? = when {
    plan.milestones.size > maxMilestones ->
        "plan has ${plan.milestones.size} milestones (max $maxMilestones)"
    else -> null
}

internal fun tasksError(tasks: List<DispatchTask>, maxTasksPerRound: Int): String? = when {
    tasks.size > maxTasksPerRound ->
        "round has ${tasks.size} tasks (max $maxTasksPerRound)"
    else -> null
}
private val RUN_ID_FORMAT = java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

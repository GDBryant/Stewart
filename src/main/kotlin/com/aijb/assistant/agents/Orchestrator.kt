package com.aijb.assistant.agents

import com.aijb.assistant.chat.ContextCompactor
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopLimits
import com.aijb.assistant.tools.LoopListener
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.RunCancelledException
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolLoop
import com.aijb.assistant.tools.ToolRegistry
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
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
//   task:    {"tasks": [{"id": 1, "description": "..."}]}
//   result:  {"task_id": 1, "status": "done" | "failed", "summary": "..."}
//
// Each level is a ToolLoop with its role prompt plus a protocol block. Levels submit
// their structured messages through terminal tools (submit_plan / submit_tasks /
// complete_milestone / submit_result); ToolLoop's schema validation rejects malformed
// output and feeds it back so the model retries. Milestones run in order; within a
// milestone the Executor may submit task rounds (bounded by maxTaskRounds) until it
// completes the milestone. An unmet milestone triggers a bounded Planner re-plan and
// the run resumes at that milestone.

object Protocol {
    const val SUBMIT_PLAN = "submit_plan"
    const val SUBMIT_TASKS = "submit_tasks"
    const val COMPLETE_MILESTONE = "complete_milestone"
    const val SUBMIT_RESULT = "submit_result"

    const val PLANNER =
        "Protocol: call ${SUBMIT_PLAN} exactly when you have the full plan. Arguments: {\"goal\": \"<overall goal>\", \"milestones\": [{\"id\": 1, \"title\": \"<short title>\", \"notes\": \"<what must be true when done>\"}]}. Milestones must be ordered and independently checkable. You have no other tools; do not do task-level work."

    const val REPLAN =
        "Protocol: a milestone could not be completed. Call ${SUBMIT_PLAN} with a corrected plan covering the remaining work: start the milestones at id ${'$'}NEXT_ID and keep them ordered and independently checkable. You have no other tools."

    const val EXECUTOR =
        "Protocol: to dispatch work, call ${SUBMIT_TASKS} with {\"tasks\": [{\"id\": 1, \"description\": \"<one concrete task a single Worker can finish alone>\"}]}. After the Worker results arrive, call ${COMPLETE_MILESTONE} with {\"notes\": \"<evidence the milestone is done>\"} when the milestone is met, or ${SUBMIT_TASKS} again with corrected or new tasks when it is not."

    const val WORKER =
        "Protocol: carry out exactly the given task using the available tools. When finished, or if you cannot finish, call ${SUBMIT_RESULT} with {\"task_id\": <id>, \"status\": \"done\" | \"failed\", \"summary\": \"<what you did, or why it failed>\"}. Do not plan beyond the task."
}

data class Milestone(val id: Int, val title: String, val notes: String)
data class Plan(val goal: String, val milestones: List<Milestone>)
data class DispatchTask(val id: Int, val description: String)
data class WorkerResult(val taskId: Int, val status: String, val summary: String)

class ProtocolException(message: String) : RuntimeException(message)

interface OrchestratorListener {
    fun onDelta(text: String)
    /** Fired before a level's first request, naming the provider/model it will be sent to. */
    fun onLevelRouted(role: AgentRole, destination: String) {}
    fun onLevelStarted(role: AgentRole, context: String)
    fun onPlan(plan: Plan)
    fun onTasks(taskRound: Int, tasks: List<DispatchTask>)
    fun onResult(result: WorkerResult)
    fun onReplanning(reason: String)
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

    private fun protocolTool(name: String, description: String, schema: JsonObject): Tool =
        object : Tool {
            override val spec = ToolSpec(name, description, schema)
            override val requiresApproval = false
            override suspend fun execute(
                arguments: JsonObject,
                preview: com.aijb.assistant.tools.ToolPreview?,
            ) = "accepted"
        }

    val PlanTool = protocolTool(
        Protocol.SUBMIT_PLAN,
        "Submit the full plan: goal plus ordered, independently checkable milestones.",
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
                            ),
                            listOf("id", "title"),
                        ),
                    )
                ),
            ),
            listOf("goal", "milestones"),
        ),
    )

    val TasksTool = protocolTool(
        Protocol.SUBMIT_TASKS,
        "Dispatch concrete tasks to the Worker. Each task must be finishable by one Worker alone.",
        objSchema(
            listOf(
                "tasks" to JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("array"),
                        "items" to objSchema(
                            listOf("id" to intType(), "description" to str()),
                            listOf("id", "description"),
                        ),
                    )
                ),
            ),
            listOf("tasks"),
        ),
    )

    val CompleteMilestoneTool = protocolTool(
        Protocol.COMPLETE_MILESTONE,
        "Declare the current milestone complete.",
        objSchema(listOf("notes" to str()), emptyList()),
    )

    val ResultTool = protocolTool(
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
    )
}

internal sealed interface LevelStatus {
    data object Completed : LevelStatus
    data object TurnLimit : LevelStatus
    data class Failed(val message: String) : LevelStatus
}

internal data class LevelRun(
    val messages: List<ChatMessage>,
    val usage: Usage?,
    val status: LevelStatus,
    val submitted: ToolCall? = null,
)

class Orchestrator(
    private val routes: Map<AgentRole, LevelRoute>,
    private val projectTools: () -> ToolRegistry,
    private val approval: ApprovalGate,
    private val limits: OrchestratorLimits = OrchestratorLimits(),
    private val compactor: ContextCompactor = ContextCompactor(),
    private val compactAtTokens: Int? = null,
) {

    /** Single-model binding: every level uses the same model and provider. */
    constructor(
        modelRef: String,
        provider: ModelProvider,
        wrapped: ModelProvider,
        projectTools: () -> ToolRegistry,
        approval: ApprovalGate,
        limits: OrchestratorLimits = OrchestratorLimits(),
        compactor: ContextCompactor = ContextCompactor(),
        compactAtTokens: Int? = null,
    ) : this(
        AgentRole.entries.associateWith { LevelRoute(ModelRef(provider.id, modelRef), wrapped) },
        projectTools, approval, limits, compactor, compactAtTokens,
    )

    /** Runs the plan; cancellation surfaces as [RunCancelledException] carrying the transcript so far. */
    suspend fun run(
        request: String,
        listener: OrchestratorListener,
        history: List<ChatMessage> = emptyList(),
    ): OrchestrationResult {
        val transcript = mutableListOf<ChatMessage>()
        val result = try {
            runSteps(request, listener, history, transcript)
        } catch (e: CancellationException) {
            val partial = (e as? RunCancelledException)?.produced ?: emptyList()
            throw RunCancelledException(emptyList(), transcript + partial, e, runUsage)
        }
        return if (result is OrchestrationResult.Failed && result.code == null) {
            result.copy(code = lastFailureCode)
        } else {
            result
        }
    }

    /** Code of the most recent failed level, so a run failure keeps its provider error code. */
    private var lastFailureCode: String? = null

    /** Usage of every level run so far (including a cancelled one), for the cancellation report. */
    private var runUsage: Usage? = null

    private suspend fun runSteps(
        request: String,
        listener: OrchestratorListener,
        history: List<ChatMessage>,
        transcript: MutableList<ChatMessage>,
    ): OrchestrationResult {
        val replans = mutableListOf<String>()
        var usage: Usage? = null

        val planRes = runLevel(
            AgentRole.PLANNER, "plan",
            RolePrompts.forRole(AgentRole.PLANNER) + " " + Protocol.PLANNER,
            listOf(ProtocolTools.PlanTool),
            setOf(Protocol.SUBMIT_PLAN),
            request,
            history,
            listener,
        )
        usage = sumUsage(usage, planRes.usage)
        transcript += planRes.messages
        val planCall = planRes.submitted
        if (planCall == null) {
            return OrchestrationResult.Failed(
                transcript, replans, "Planner: ${failureMessage(planRes)}", usage
            )
        }
        val plan = try {
            parsePlan(planCall)
        } catch (e: ProtocolException) {
            return OrchestrationResult.Failed(transcript, replans, "invalid plan: ${e.message}", usage)
        }
        val planError = planError(plan, limits.maxMilestones)
        if (planError != null) {
            return OrchestrationResult.Failed(transcript, replans, planError, usage)
        }
        var currentPlan = plan
        listener.onPlan(currentPlan)

        val finished = mutableListOf<Pair<Milestone, String>>()
        var start = 0
        outer@ while (true) {
            for (i in start until currentPlan.milestones.size) {
                val milestone = currentPlan.milestones[i]
                val results = mutableListOf<WorkerResult>()
                var round = 0
                var execBase = emptyList<ChatMessage>()
                var done = false
                while (!done) {
                    round++
                    if (round > limits.maxTaskRounds) {
                        milestoneFailed(
                            transcript, replans, listener,
                            "milestone '${milestone.title}' (${milestone.id}) not met after ${limits.maxTaskRounds} task rounds",
                        )
                        break
                    }
                    val content = buildString {
                        append("Goal: ${currentPlan.goal}\n")
                        append("Milestone ${milestone.id}: ${milestone.title}\n")
                        if (milestone.notes.isNotBlank()) append("Definition of done: ${milestone.notes}\n")
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
                    val res = runLevel(
                        AgentRole.EXECUTOR,
                        "milestone '${milestone.title}' (${milestone.id}), round $round",
                        RolePrompts.forRole(AgentRole.EXECUTOR) + " " + Protocol.EXECUTOR,
                        listOf(ProtocolTools.TasksTool, ProtocolTools.CompleteMilestoneTool),
                        setOf(Protocol.SUBMIT_TASKS, Protocol.COMPLETE_MILESTONE),
                        content,
                        execBase,
                        listener,
                    )
                    usage = sumUsage(usage, res.usage)
                    transcript += res.messages
                    val call = res.submitted
                    if (call == null) {
                        milestoneFailed(
                            transcript, replans, listener,
                            "milestone '${milestone.title}' (${milestone.id}): ${failureMessage(res)}",
                        )
                        break
                    }
                    execBase = execBase + ChatMessage(Role.USER, content) + res.messages
                    when (call.name) {
                        Protocol.COMPLETE_MILESTONE -> {
                            val notes = call.arguments["notes"]?.jsonPrimitive?.content.orEmpty()
                            finished += milestone to bound(notes)
                            done = true
                        }
                        Protocol.SUBMIT_TASKS -> {
                            val tasks = try {
                                parseTasks(call)
                            } catch (e: ProtocolException) {
                                return OrchestrationResult.Failed(
                                    transcript, replans, "invalid task list: ${e.message}", usage
                                )
                            }
                            val taskError = tasksError(tasks, limits.maxTasksPerRound)
                            if (taskError != null) {
                                return OrchestrationResult.Failed(transcript, replans, taskError, usage)
                            }
                            listener.onTasks(round, tasks)
                            val workerUsage = runTasksSerially(
                                currentPlan.goal, milestone, tasks, results, transcript, listener
                            )
                            usage = sumUsage(usage, workerUsage)
                        }
                        else ->
                            return OrchestrationResult.Failed(
                                transcript, replans, "Executor submitted unexpected tool '${call.name}'", usage
                            )
                    }
                }
                if (!done) {
                    if (replans.size >= limits.maxReplans) {
                        return OrchestrationResult.Failed(
                            transcript, replans, "re-planning budget exhausted: ${replans.last()}", usage
                        )
                    }
                    val replanned = replan(currentPlan, milestone, replans.last(), transcript, listener)
                    usage = sumUsage(usage, replanned.usage)
                    if (replanned.submitted == null) {
                        return OrchestrationResult.Failed(
                            transcript, replans, "re-plan failed: ${failureMessage(replanned)}", usage
                        )
                    }
                    val newPlan = try {
                        parsePlan(replanned.submitted!!, startId = milestone.id)
                    } catch (e: ProtocolException) {
                        return OrchestrationResult.Failed(
                            transcript, replans, "invalid re-plan: ${e.message}", usage
                        )
                    }
                    val rePlanError = planError(newPlan, limits.maxMilestones)
                    if (rePlanError != null) {
                        return OrchestrationResult.Failed(transcript, replans, rePlanError, usage)
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
        transcript: MutableList<ChatMessage>,
        listener: OrchestratorListener,
    ): LevelRun {
        val content = buildString {
            append("Goal: ${plan.goal}\n")
            append("Milestone ${milestone.id}: ${milestone.title} could not be completed.\n")
            append("Reason: $reason\n")
            append(
                "Milestones after ${milestone.id} are still: " +
                    plan.milestones.filter { it.id > milestone.id }.joinToString { it.title } + "\n"
            )
        }
        val res = runLevel(
            AgentRole.PLANNER, "re-plan",
            RolePrompts.forRole(AgentRole.PLANNER) + " " +
                Protocol.REPLAN.replace("\$NEXT_ID", milestone.id.toString()),
            listOf(ProtocolTools.PlanTool),
            setOf(Protocol.SUBMIT_PLAN),
            content,
            emptyList(),
            listener,
        )
        transcript.addAll(res.messages)
        return res
    }

    private fun milestoneFailed(
        transcript: MutableList<ChatMessage>,
        replans: MutableList<String>,
        listener: OrchestratorListener,
        reason: String,
    ) {
        replans += reason
        listener.onReplanning(reason)
        transcript.add(ChatMessage(Role.SYSTEM, "Re-planning: $reason"))
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
        for (task in tasks) {
            listener.onLevelStarted(
                AgentRole.WORKER,
                "milestone '${milestone.title}' (${milestone.id}), task ${task.id}: ${task.description}",
            )
            val content =
                "Goal: $goal\nMilestone: ${milestone.title} (${milestone.id})\nTask ${task.id}: ${task.description}"
            val res = runLevel(
                AgentRole.WORKER, "task ${task.id}",
                RolePrompts.forRole(AgentRole.WORKER) + " " + Protocol.WORKER,
                projectTools().tools + ProtocolTools.ResultTool,
                setOf(Protocol.SUBMIT_RESULT),
                content,
                emptyList(),
                listener,
            )
            usage = sumUsage(usage, res.usage)
            transcript += res.messages
            val call = res.submitted
            val result = when {
                call != null && call.name == Protocol.SUBMIT_RESULT -> try {
                    parseResult(call, task.id)
                } catch (e: ProtocolException) {
                    WorkerResult(task.id, "failed", "malformed result: ${e.message}")
                }
                else -> WorkerResult(
                    task.id, "failed",
                    "no result submitted: ${failureMessage(res)}",
                )
            }
            results += result
            listener.onResult(result)
        }
        return usage
    }

    private suspend fun runLevel(
        role: AgentRole,
        context: String,
        system: String,
        tools: List<Tool>,
        terminal: Set<String>,
        userContent: String,
        baseHistory: List<ChatMessage>,
        listener: OrchestratorListener,
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
            approval,
            LoopLimits(
                maxModelTurns = limits.maxLevelModelTurns,
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
            ChatMessage(Role.USER, userContent)
        val result = try {
            loop.run(route.ref.modelId, base, loopListener)
        } catch (e: RunCancelledException) {
            runUsage = sumUsage(runUsage, e.usage)
            throw e
        }
        runUsage = sumUsage(runUsage, result.usage)
        val submitted = result.messages.lastOrNull { m -> m.toolCalls.any { it.name in terminal } }
            ?.toolCalls?.firstOrNull { it.name in terminal }
        val status = when (result) {
            is LoopResult.Completed ->
                if (submitted != null) LevelStatus.Completed
                else LevelStatus.Failed("${role.name.lowercase()} finished without submitting a structured result")
            is LoopResult.TurnLimitReached -> LevelStatus.TurnLimit
            is LoopResult.Failed -> {
                lastFailureCode = result.code
                LevelStatus.Failed("${route.label}: ${result.message}")
            }
        }
        return LevelRun(result.messages, result.usage, status, submitted)
    }

    /** Caps text handed between levels so one verbose result cannot flood the next model. */
    private fun bound(text: String): String =
        if (text.length <= limits.maxHandoffChars) text
        else text.take(limits.maxHandoffChars) + "… [truncated ${text.length - limits.maxHandoffChars} chars]"

    private fun failureMessage(res: LevelRun): String = when (val s = res.status) {
        is LevelStatus.Completed -> "no submission"
        is LevelStatus.TurnLimit -> "produced no structured result within the turn limit"
        is LevelStatus.Failed -> s.message
    }

    private fun sumUsage(a: Usage?, b: Usage?): Usage? = when {
        a == null -> b
        b == null -> a
        else -> a + b
    }
}

// --- protocol parsing ---------------------------------------------------------

internal fun parsePlan(call: ToolCall, startId: Int = 1): Plan {
    val args = call.arguments
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
        Milestone(id, title, notes)
    }
    val expected = (startId..(startId + milestones.size - 1)).toList()
    if (milestones.map { it.id } != expected) {
        throw ProtocolException("milestone ids must be ${expected.first()}..${expected.last()} in order")
    }
    return Plan(goal, milestones)
}

internal fun parseTasks(call: ToolCall): List<DispatchTask> {
    val tasksEl = call.arguments["tasks"]
    if (tasksEl !is JsonArray) throw ProtocolException("'tasks' must be an array")
    val seen = mutableSetOf<Int>()
    return tasksEl.mapIndexed { index, el ->
        val obj = el as? JsonObject ?: throw ProtocolException("task $index is not an object")
        val id = obj["id"]?.jsonPrimitive?.intOrNull
            ?: throw ProtocolException("task $index missing integer 'id'")
        val description = obj["description"]?.jsonPrimitive?.content
        if (description.isNullOrBlank()) throw ProtocolException("task $id missing 'description'")
        if (!seen.add(id)) throw ProtocolException("duplicate task id $id")
        DispatchTask(id, description)
    }
}

internal fun parseResult(call: ToolCall, expectedTaskId: Int): WorkerResult {
    val args = call.arguments
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
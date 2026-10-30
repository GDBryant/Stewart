package com.aijb.assistant.chat

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.DispatchTask
import com.aijb.assistant.agents.OrchestrationResult
import com.aijb.assistant.agents.Orchestrator
import com.aijb.assistant.agents.OrchestratorListener
import com.aijb.assistant.agents.UserPrompter
import com.aijb.assistant.agents.Plan
import com.aijb.assistant.agents.RoleRouting
import com.aijb.assistant.agents.RoutingResult
import com.aijb.assistant.agents.WorkerResult
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderRegistry
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopLimits
import com.aijb.assistant.tools.LoopListener
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.ProjectTools
import com.aijb.assistant.tools.RunCancelledException
import com.aijb.assistant.tools.ToolLoop
import com.aijb.assistant.tools.ToolOutcome
import com.aijb.assistant.tools.ToolRegistry
import com.aijb.assistant.ui.IdeApprovalGate
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

interface ChatListener {
    fun onDelta(text: String)
    fun onCompleted(usage: Usage?)
    fun onFailed(message: String)
    fun onCancelled()
    /** Cancellation with the number of tool calls whose side effects are unknown (not rolled back). */
    fun onCancelledWithOutcomes(uncertainOutcomes: Int) = onCancelled()
    /** Failure with the provider/loop error [code] (null when unknown), for actionable hints. */
    fun onFailedWithCode(message: String, code: String?) = onFailed(message)
    fun onCompacted(beforeTokens: Int, afterTokens: Int) {}
    fun onCompactionFailed(message: String) {}
    fun onLevelStarted(role: AgentRole, context: String) {}
    fun onToolRequested(call: ToolCall) {}
    fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) {}
    /** The Planner asked a question; the run blocks until [ChatSession.answerQuestion] or cancel. */
    fun onQuestion(question: String, options: List<String>) {}
}

@Service(Service.Level.PROJECT)
class ChatSession(
    private val project: Project,
    private val cs: CoroutineScope,
) : Disposable {

    var providers: () -> List<ModelProvider> = { ProviderRegistry.getInstance().providers() }
    var autoCompactTokens: () -> Int = { AijbSettings.getInstance().state.autoCompactTokens }
    var multiModel: () -> Boolean = { AijbSettings.getInstance().state.multiModel }
    var toolPathOverrides: () -> Map<String, String> = {
        AijbSettings.getInstance().state.toolPathOverrides
    }
    var tools: () -> ToolRegistry = {
        ProjectTools.registry(project, AijbSettings.getInstance().state.toolsEnabled)
    }
    var approval: ApprovalGate = IdeApprovalGate(project,
        { AijbSettings.getInstance().state.autoApproveEdits })
    var roleModels: () -> Map<AgentRole, ModelRef?> = {
        val st = AijbSettings.getInstance().state
        mapOf(
            AgentRole.PLANNER to ModelRef.decode(st.plannerModel),
            AgentRole.EXECUTOR to ModelRef.decode(st.executorModel),
            AgentRole.WORKER to ModelRef.decode(st.workerModel),
        )
    }
    internal var compactor = ContextCompactor()

    /** Days to keep saved history; 0 disables persistence. */
    var historyRetentionDays: () -> Int = { AijbSettings.getInstance().state.historyRetentionDays }

    /** Null disables persistence (always the case in unit-test mode unless a test sets a store). */
    var historyStore: ChatHistoryStore? = defaultHistoryStore(project)

    private var lastPromptTokens: Int? = null

    private val lock = Any()
    private val transcriptBacking = mutableListOf<ChatMessage>()
    private var activeJob: Job? = null
    private var pendingAnswer: CompletableDeferred<String>? = null
    private var usageBacking: Usage? = null

    val transcript: List<ChatMessage>
        get() = synchronized(lock) { transcriptBacking.toList() }

    /** Tokens and cost summed over every completed request in this chat (restored with history). */
    val sessionUsage: Usage?
        get() = synchronized(lock) { usageBacking }

    init {
        restoreHistory()
    }

    private fun addUsage(usage: Usage?) {
        if (usage == null) return
        synchronized(lock) { usageBacking = usageBacking?.plus(usage) ?: usage }
    }

    /** Loads saved history if this chat is empty and idle; unreadable or expired files are dropped. */
    fun restoreHistory() {
        val store = historyStore ?: return
        val days = historyRetentionDays()
        val loaded = try {
            store.file.parent?.let { ChatHistoryStore.pruneExpired(it, days) }
            store.load(days)
        } catch (e: Exception) {
            LOG.warn("Could not load chat history: ${e.javaClass.simpleName}")
            null
        } ?: return
        synchronized(lock) {
            if (activeJob == null && transcriptBacking.isEmpty()) {
                transcriptBacking.addAll(loaded.messages)
                usageBacking = loaded.usage
            }
        }
    }

    private fun persist() {
        val store = historyStore ?: return
        try {
            if (historyRetentionDays() <= 0) {
                store.delete()
            } else {
                val (snapshot, usage) = synchronized(lock) { transcriptBacking.toList() to usageBacking }
                store.save(snapshot, usage)
            }
        } catch (e: Exception) {
            LOG.warn("Could not save chat history: ${e.javaClass.simpleName}")
        }
    }

    /** Cancels any run and wipes the transcript, usage totals and the saved file. */
    fun clearHistory() {
        synchronized(lock) {
            activeJob?.cancel()
            activeJob = null
            transcriptBacking.clear()
            usageBacking = null
            lastPromptTokens = null
        }
        try {
            historyStore?.delete()
        } catch (e: Exception) {
            LOG.warn("Could not delete chat history: ${e.javaClass.simpleName}")
        }
    }

    private fun toEdt(block: () -> Unit) {
        ApplicationManager.getApplication().invokeLater({ block() }, ModalityState.any())
    }

    fun send(text: String, ref: ModelRef, listener: ChatListener): Job {
        val newJob: Job
        synchronized(lock) {
            activeJob?.cancel()
            val priorHistory = transcriptBacking.toList()
            transcriptBacking.add(ChatMessage(Role.USER, text))
            val history = transcriptBacking.toList()
            // ATOMIC: a Stop before dispatch still runs the body, so catch/finally always fire.
            newJob = cs.launch(start = CoroutineStart.ATOMIC) {
                val thisJob = coroutineContext.job
                var orchestrated = false
                try {
                    coroutineContext.ensureActive()
                    if (multiModel()) {
                        orchestrated = true
                        runOrchestrator(text, ref, priorHistory, listener, thisJob)
                        return@launch
                    }
                    val route = RoleRouting.routeFor(ref, providers(), toolPathOverrides())
                    if (route == null) {
                        toEdt {
                            listener.onFailedWithCode("Provider not configured: ${ref.providerId}", "provider_missing")
                        }
                        return@launch
                    }
                    val loopListener = object : LoopListener {
                        override fun onText(text: String) = toEdt { listener.onDelta(text) }
                        override fun onToolRequested(call: ToolCall) =
                            toEdt { listener.onToolRequested(call) }
                        override fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) =
                            toEdt { listener.onToolOutcome(call, outcome) }
                        override fun onCompacted(beforeTokens: Int, afterTokens: Int) =
                            toEdt { listener.onCompacted(beforeTokens, afterTokens) }
                        override fun onCompactionFailed(message: String) =
                            toEdt { listener.onCompactionFailed(message) }
                    }
                    val loop = ToolLoop(
                        route.provider, tools(), approval,
                        LoopLimits(
                            maxModelTurns = 25,
                            toolTimeout = 120.seconds,
                            compactAtTokens = autoCompactTokens(),
                        ),
                        compactor,
                    )
                    val result = loop.run(ref.modelId, history, loopListener, lastPromptTokens)
                    when (result) {
                        is LoopResult.Completed -> {
                            var t = result.transcript
                            t.lastOrNull()?.let {
                                if (it.role == Role.ASSISTANT && it.content.isBlank() && it.toolCalls.isEmpty()) {
                                    t = t.dropLast(1)
                                }
                            }
                            commitIfActive(thisJob, t)
                            lastPromptTokens = result.usage?.promptTokens
                            addUsage(result.usage)
                            toEdt { listener.onCompleted(result.usage) }
                        }
                        is LoopResult.Failed -> {
                            commitIfActive(thisJob, result.transcript)
                            addUsage(result.usage)
                            toEdt { listener.onFailedWithCode(result.message, result.code) }
                        }
                        is LoopResult.TurnLimitReached -> {
                            commitIfActive(thisJob, result.transcript)
                            addUsage(result.usage)
                            toEdt { listener.onFailedWithCode("Stopped: tool-turn limit reached (25)", "turn_limit") }
                        }
                    }
                } catch (e: CancellationException) {
                    val cancelled = e as? RunCancelledException
                    addUsage(cancelled?.usage)
                    synchronized(lock) {
                        if (activeJob === thisJob) {
                            val kept = when {
                                cancelled == null -> transcriptBacking.toList()
                                orchestrated -> listOf(ChatMessage(Role.USER, text)) +
                                    cancelled.produced.filter { it.role != Role.SYSTEM }
                                else -> cancelled.transcript
                            }
                            transcriptBacking.clear()
                            transcriptBacking.addAll(withCancelMarker(kept))
                        }
                    }
                    val uncertain = cancelled?.uncertainOutcomes ?: 0
                    toEdt { listener.onCancelledWithOutcomes(uncertain) }
                    throw e
                } catch (e: Throwable) {
                    toEdt { listener.onFailed(e.message ?: "error") }
                } finally {
                    synchronized(lock) {
                        if (activeJob === thisJob) activeJob = null
                    }
                    persist()
                }
            }
            activeJob = newJob
        }
        return newJob
    }

    /**
     * Multi-model mode (M6/M7): runs the three-level orchestrator, each level bound to its
     * configured model (unset roles use the chat selection). A role whose provider is
     * missing fails the request; it is never rerouted to another provider.
     */
    private suspend fun runOrchestrator(
        text: String,
        ref: ModelRef,
        priorHistory: List<ChatMessage>,
        listener: ChatListener,
        thisJob: Job,
    ) {
        val routed = RoleRouting.resolve(
            ref,
            roleModels(),
            providers(),
            toolPathOverrides(),
        )
        val routes = when (routed) {
            is RoutingResult.Resolved -> routed.routes
            is RoutingResult.Unresolved -> {
                toEdt { listener.onFailedWithCode(routed.message, "provider_missing") }
                return
            }
        }
        val destinations = mutableMapOf<AgentRole, String>()
        val orchListener = object : OrchestratorListener {
            override fun onDelta(delta: String) = toEdt { listener.onDelta(delta) }
            override fun onLevelRouted(role: AgentRole, destination: String) {
                destinations[role] = destination
            }
            override fun onLevelStarted(role: AgentRole, context: String) {
                val dest = destinations[role]
                toEdt { listener.onLevelStarted(role, if (dest != null) "$context → $dest" else context) }
            }
            override fun onQuestion(question: String, options: List<String>) {
                // Registered before the UI hears of it, so an immediate answer cannot be lost.
                synchronized(lock) { pendingAnswer = CompletableDeferred() }
                toEdt { listener.onQuestion(question, options) }
            }
            override fun onPlan(plan: Plan) {}
            override fun onTasks(taskRound: Int, tasks: List<DispatchTask>) {}
            override fun onResult(result: WorkerResult) {}
            override fun onReplanning(reason: String) =
                toEdt { listener.onDelta("\n[re-planning: $reason]\n") }
            override fun onCompleted(usage: Usage?) {
                addUsage(usage)
                toEdt { listener.onCompleted(usage) }
            }
            override fun onFailed(message: String) = toEdt { listener.onFailed(message) }
        }
        val orchestrator = Orchestrator(
            routes = routes,
            projectTools = { tools() },
            approval = approval,
            compactAtTokens = autoCompactTokens(),
            prompter = UserPrompter { _, _ ->
                val pending = checkNotNull(synchronized(lock) { pendingAnswer }) { "no pending question" }
                try {
                    pending.await()
                } finally {
                    synchronized(lock) { if (pendingAnswer === pending) pendingAnswer = null }
                }
            },
        )
        val result = orchestrator.run(text, orchListener, priorHistory)
        // SYSTEM messages in the result are the orchestrator's "Re-planning: ..." markers; role
        // prompts are injected per request and never appear in result.messages.
        commitIfActive(thisJob, listOf(ChatMessage(Role.USER, text)) + result.messages.filter { it.role != Role.SYSTEM })
        if (result is OrchestrationResult.Failed) {
            addUsage(result.usage)
            toEdt { listener.onFailedWithCode(result.message, result.code) }
        }
    }

    /** Replaces the transcript with [messages] unless a newer request has superseded [job]. */
    internal fun commitIfActive(job: Job?, messages: List<ChatMessage>) {
        synchronized(lock) {
            if (activeJob === job) {
                transcriptBacking.clear()
                transcriptBacking.addAll(messages)
            }
        }
    }

    /** Delivers the user's reply to the Planner's pending question; false when none is waiting. */
    fun answerQuestion(answer: String): Boolean =
        synchronized(lock) { pendingAnswer }?.complete(answer) ?: false

    fun cancel() {
        synchronized(lock) { activeJob }?.cancel()
    }

    override fun dispose() {
        cancel()
        persist()
    }

    companion object {
        const val CANCEL_MARKER = "[Cancelled by user]"
        private val LOG = Logger.getInstance(ChatSession::class.java)

        fun getInstance(project: Project): ChatSession = project.service()

        /** Marks a cancelled run so later turns (and the user) see it was interrupted. */
        internal fun withCancelMarker(messages: List<ChatMessage>): List<ChatMessage> {
            val last = messages.lastOrNull()
            return if (last != null && last.role == Role.ASSISTANT && last.toolCalls.isEmpty()) {
                messages.dropLast(1) + last.copy(content = last.content + "\n" + CANCEL_MARKER)
            } else {
                messages + ChatMessage(Role.ASSISTANT, CANCEL_MARKER)
            }
        }

        private fun defaultHistoryStore(project: Project): ChatHistoryStore? =
            if (ApplicationManager.getApplication().isUnitTestMode) {
                null
            } else {
                ChatHistoryStore(ChatHistoryStore.pathFor(PathManager.getSystemDir(), project.locationHash))
            }
    }
}

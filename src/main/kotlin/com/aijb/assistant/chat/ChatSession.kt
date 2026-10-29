package com.aijb.assistant.chat

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.DispatchTask
import com.aijb.assistant.agents.OrchestrationResult
import com.aijb.assistant.agents.Orchestrator
import com.aijb.assistant.agents.OrchestratorListener
import com.aijb.assistant.agents.Plan
import com.aijb.assistant.agents.WorkerResult
import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderRegistry
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.aijb.assistant.settings.ToolPathResolver
import com.aijb.assistant.shim.ToolCallingProvider
import com.aijb.assistant.tools.ApprovalGate
import com.aijb.assistant.tools.LoopLimits
import com.aijb.assistant.tools.LoopListener
import com.aijb.assistant.tools.LoopResult
import com.aijb.assistant.tools.ProjectTools
import com.aijb.assistant.tools.ToolLoop
import com.aijb.assistant.tools.ToolOutcome
import com.aijb.assistant.tools.ToolRegistry
import com.aijb.assistant.ui.IdeApprovalGate
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

interface ChatListener {
    fun onDelta(text: String)
    fun onCompleted(usage: Usage?)
    fun onFailed(message: String)
    fun onCancelled()
    fun onCompacted(beforeTokens: Int, afterTokens: Int) {}
    fun onCompactionFailed(message: String) {}
    fun onLevelStarted(role: AgentRole, context: String) {}
    fun onToolRequested(call: ToolCall) {}
    fun onToolOutcome(call: ToolCall, outcome: ToolOutcome) {}
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
    internal var compactor = ContextCompactor()

    private var lastPromptTokens: Int? = null

    private val lock = Any()
    private val transcriptBacking = mutableListOf<ChatMessage>()
    private var activeJob: Job? = null

    val transcript: List<ChatMessage>
        get() = synchronized(lock) { transcriptBacking.toList() }

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
            newJob = cs.launch {
                val thisJob = coroutineContext.job
                try {
                    val provider = providers().firstOrNull { it.id == ref.providerId }
                    if (provider == null) {
                        toEdt { listener.onFailed("Provider not configured: ${ref.providerId}") }
                        return@launch
                    }
                    val wrapped = ToolCallingProvider(
                        provider, ToolPathResolver.resolve(ref, provider, toolPathOverrides()))
                    if (multiModel()) {
                        runOrchestrator(text, ref, provider, wrapped, priorHistory, listener, thisJob)
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
                        wrapped, tools(), approval,
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
                            synchronized(lock) {
                                if (activeJob === thisJob) {
                                    transcriptBacking.clear()
                                    transcriptBacking.addAll(t)
                                }
                            }
                            lastPromptTokens = result.usage?.promptTokens
                            toEdt { listener.onCompleted(result.usage) }
                        }
                        is LoopResult.Failed -> {
                            synchronized(lock) {
                                if (activeJob === thisJob) {
                                    transcriptBacking.clear()
                                    transcriptBacking.addAll(result.transcript)
                                }
                            }
                            toEdt { listener.onFailed(result.message) }
                        }
                        is LoopResult.TurnLimitReached -> {
                            synchronized(lock) {
                                if (activeJob === thisJob) {
                                    transcriptBacking.clear()
                                    transcriptBacking.addAll(result.transcript)
                                }
                            }
                            toEdt { listener.onFailed("Stopped: tool-turn limit reached (25)") }
                        }
                    }
                } catch (e: CancellationException) {
                    toEdt { listener.onCancelled() }
                    throw e
                } catch (e: Throwable) {
                    toEdt { listener.onFailed(e.message ?: "error") }
                } finally {
                    synchronized(lock) {
                        if (activeJob === thisJob) activeJob = null
                    }
                }
            }
            activeJob = newJob
        }
        return newJob
    }

    /**
     * Multi-model mode (M6): runs the three-level orchestrator. All levels are bound to
     * the selected chat model; per-role model binding arrives with M7.
     */
    private suspend fun runOrchestrator(
        text: String,
        ref: ModelRef,
        provider: ModelProvider,
        wrapped: ModelProvider,
        priorHistory: List<ChatMessage>,
        listener: ChatListener,
        thisJob: Job,
    ) {
        val orchListener = object : OrchestratorListener {
            override fun onDelta(delta: String) = toEdt { listener.onDelta(delta) }
            override fun onLevelStarted(role: AgentRole, context: String) =
                toEdt { listener.onLevelStarted(role, context) }
            override fun onPlan(plan: Plan) {}
            override fun onTasks(taskRound: Int, tasks: List<DispatchTask>) {}
            override fun onResult(result: WorkerResult) {}
            override fun onReplanning(reason: String) =
                toEdt { listener.onDelta("\n[re-planning: $reason]\n") }
            override fun onCompleted(usage: Usage?) = toEdt { listener.onCompleted(usage) }
            override fun onFailed(message: String) = toEdt { listener.onFailed(message) }
        }
        val orchestrator = Orchestrator(
            modelRef = ref.modelId,
            provider = provider,
            wrapped = wrapped,
            projectTools = { tools() },
            approval = approval,
            compactAtTokens = autoCompactTokens(),
        )
        val result = orchestrator.run(text, orchListener, priorHistory)
        synchronized(lock) {
            if (activeJob === thisJob) {
                transcriptBacking.clear()
                transcriptBacking.add(ChatMessage(Role.USER, text))
                // Per-level role prompts are injected per request and never stored.
                transcriptBacking.addAll(result.messages.filter { it.role != Role.SYSTEM })
            }
        }
        if (result is OrchestrationResult.Failed) {
            toEdt { listener.onFailed(result.message) }
        }
    }

    fun cancel() {
        synchronized(lock) { activeJob }?.cancel()
    }

    override fun dispose() {
        cancel()
    }

    companion object {
        fun getInstance(project: Project): ChatSession = project.service()
    }
}

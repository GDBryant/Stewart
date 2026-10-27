package com.aijb.assistant.chat

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.ProviderRegistry
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
import com.aijb.assistant.settings.AijbSettings
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.EDT
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

interface ChatListener {
    fun onDelta(text: String)
    fun onCompleted(usage: Usage?)
    fun onFailed(message: String)
    fun onCancelled()
    fun onCompacted(beforeTokens: Int, afterTokens: Int) {}
    fun onCompactionFailed(message: String) {}
}

@Service(Service.Level.PROJECT)
class ChatSession(
    private val project: Project,
    private val cs: CoroutineScope,
) : Disposable {

    var providers: () -> List<ModelProvider> = { ProviderRegistry.getInstance().providers() }
    var autoCompactTokens: () -> Int = { AijbSettings.getInstance().state.autoCompactTokens }
    internal var compactor = ContextCompactor()

    private var lastPromptTokens: Int? = null

    private val lock = Any()
    private val transcriptBacking = mutableListOf<ChatMessage>()
    private var activeJob: Job? = null

    val transcript: List<ChatMessage>
        get() = synchronized(lock) { transcriptBacking.toList() }

    fun send(text: String, ref: ModelRef, listener: ChatListener): Job {
        val newJob: Job
        synchronized(lock) {
            activeJob?.cancel()
            transcriptBacking.add(ChatMessage(Role.USER, text))
            val history = transcriptBacking.toList()
            newJob = cs.launch {
                val thisJob = coroutineContext.job
                val reply = StringBuilder()
                var completed = false
                try {
                    val provider = providers().firstOrNull { it.id == ref.providerId }
                    if (provider == null) {
                        withContext(Dispatchers.EDT) {
                            listener.onFailed("Provider not configured: ${ref.providerId}")
                        }
                        return@launch
                    }
                    var requestHistory = history
                    val compaction = compactor.compactIfNeeded(
                        provider, ref.modelId, history, autoCompactTokens(), lastPromptTokens)
                    if (compaction.error != null) {
                        withContext(Dispatchers.EDT) { listener.onCompactionFailed(compaction.error!!) }
                    } else if (compaction.compacted) {
                        synchronized(lock) {
                            transcriptBacking.clear()
                            transcriptBacking.addAll(compaction.messages)
                        }
                        requestHistory = compaction.messages
                        lastPromptTokens = null
                        withContext(Dispatchers.EDT) {
                            listener.onCompacted(compaction.beforeTokens, compaction.afterTokens)
                        }
                    }
                    provider.chat(ChatRequest(ref.modelId, requestHistory)).collect { event ->
                        when (event) {
                            is ProviderEvent.TextDelta -> {
                                reply.append(event.text)
                                withContext(Dispatchers.EDT) { listener.onDelta(event.text) }
                            }
                            is ProviderEvent.Completed -> {
                                completed = true
                                lastPromptTokens = event.usage?.promptTokens
                                withContext(Dispatchers.EDT) { listener.onCompleted(event.usage) }
                            }
                            is ProviderEvent.Failed ->
                                withContext(Dispatchers.EDT) { listener.onFailed(event.message) }
                            else -> {}
                        }
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    withContext(NonCancellable + Dispatchers.EDT) { listener.onCancelled() }
                    throw e
                } finally {
                    if (completed && reply.isNotEmpty()) {
                        synchronized(lock) { transcriptBacking.add(ChatMessage(Role.ASSISTANT, reply.toString())) }
                    }
                    synchronized(lock) {
                        if (activeJob === thisJob) activeJob = null
                    }
                }
            }
            activeJob = newJob
        }
        return newJob
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

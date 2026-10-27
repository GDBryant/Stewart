package com.aijb.assistant.chat

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.ProviderRegistry
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
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
}

@Service(Service.Level.PROJECT)
class ChatSession(
    private val project: Project,
    private val cs: CoroutineScope,
) : Disposable {

    var providers: () -> List<ModelProvider> = { ProviderRegistry.getInstance().providers() }

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
                    provider.chat(ChatRequest(ref.modelId, history)).collect { event ->
                        when (event) {
                            is ProviderEvent.TextDelta -> {
                                reply.append(event.text)
                                withContext(Dispatchers.EDT) { listener.onDelta(event.text) }
                            }
                            is ProviderEvent.Completed -> {
                                completed = true
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

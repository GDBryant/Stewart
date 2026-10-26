package com.aijb.assistant.provider

import kotlinx.coroutines.flow.Flow

data class ModelRef(val providerId: String, val modelId: String)

data class ModelInfo(val ref: ModelRef, val displayName: String)

enum class Role { SYSTEM, USER, ASSISTANT }

data class ChatMessage(val role: Role, val content: String)

data class ChatRequest(val model: String, val messages: List<ChatMessage>)

data class Usage(val promptTokens: Int?, val completionTokens: Int?)

sealed interface ProviderEvent {
    data class TextDelta(val text: String) : ProviderEvent
    data class Completed(val finishReason: String?, val usage: Usage?) : ProviderEvent
    data class Failed(val message: String, val cause: Throwable? = null) : ProviderEvent
}

interface ModelProvider {
    val id: String
    suspend fun listModels(): List<ModelInfo>
    fun chat(request: ChatRequest): Flow<ProviderEvent>
}

package com.aijb.assistant.provider

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject

data class ModelRef(val providerId: String, val modelId: String)

data class ModelInfo(val ref: ModelRef, val displayName: String)

enum class Role { SYSTEM, USER, ASSISTANT, TOOL }

data class ToolCall(val id: String, val name: String, val arguments: JsonObject)

data class RawToolCall(val id: String?, val name: String, val arguments: String)

data class ChatMessage(
    val role: Role,
    val content: String,
    val toolCalls: List<ToolCall> = emptyList(),
    val toolCallId: String? = null,
)

data class ToolSpec(val name: String, val description: String, val parameters: JsonObject)

sealed interface ToolChoice {
    data object Auto : ToolChoice
    data object None : ToolChoice
    data object Required : ToolChoice
    data class Function(val name: String) : ToolChoice
}

data class ChatRequest(
    val model: String,
    val messages: List<ChatMessage>,
    val tools: List<ToolSpec> = emptyList(),
    val toolChoice: ToolChoice = ToolChoice.Auto,
    val parallelToolCalls: Boolean? = null,
)

data class Usage(val promptTokens: Int?, val completionTokens: Int?)

sealed interface ProviderEvent {
    data class TextDelta(val text: String) : ProviderEvent
    data class ReasoningDelta(val text: String) : ProviderEvent
    data class NativeToolCalls(val calls: List<RawToolCall>) : ProviderEvent
    data class ToolCalls(val calls: List<ToolCall>) : ProviderEvent
    data class Completed(val finishReason: String?, val usage: Usage?) : ProviderEvent
    data class Failed(val message: String, val cause: Throwable? = null, val code: String? = null) : ProviderEvent
}

enum class ToolPath { NATIVE, SHIM }

interface ModelProvider {
    val id: String
    suspend fun listModels(): List<ModelInfo>
    fun chat(request: ChatRequest): Flow<ProviderEvent>
    fun supportsNativeTools(model: String): Boolean = false
}

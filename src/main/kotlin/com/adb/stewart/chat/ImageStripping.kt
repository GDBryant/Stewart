package com.adb.stewart.chat

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ProviderEvent
import kotlinx.coroutines.flow.Flow

/** Replaces each message's images with `[image: name]` text; messages without images are returned as is. */
fun stripImages(messages: List<ChatMessage>): List<ChatMessage> = messages.map { m ->
    if (m.images.isEmpty()) {
        m
    } else {
        val marks = m.images.joinToString("\n") { "[image: ${it.name}]" }
        m.copy(content = if (m.content.isBlank()) marks else m.content + "\n" + marks, images = emptyList())
    }
}

/**
 * Outgoing-request guard: when the model can't take images, history images are sent as text
 * placeholders. Only the request copy changes; the stored transcript keeps its images.
 */
class ImageStrippingProvider(private val inner: ModelProvider) : ModelProvider {
    override val id: String = inner.id
    override suspend fun listModels(): List<ModelInfo> = inner.listModels()
    override fun supportsNativeTools(model: String): Boolean = inner.supportsNativeTools(model)
    override fun supportsImages(model: String): Boolean = inner.supportsImages(model)

    override fun chat(request: ChatRequest): Flow<ProviderEvent> =
        if (inner.supportsImages(request.model) || request.messages.none { it.images.isNotEmpty() }) {
            inner.chat(request)
        } else {
            inner.chat(request.copy(messages = stripImages(request.messages)))
        }
}

package com.aijb.assistant.shim

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolChoice
import com.aijb.assistant.provider.ToolPath
import com.aijb.assistant.provider.Usage
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

class ToolCallingProvider(
    private val inner: ModelProvider,
    private val path: ToolPath,
    private val retries: Int = 1,
) : ModelProvider {

    override val id: String = inner.id

    override suspend fun listModels(): List<ModelInfo> = inner.listModels()

    override fun supportsNativeTools(model: String): Boolean = inner.supportsNativeTools(model)

    override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
        val offered = try {
            RequestTranslator.offeredTools(request)
        } catch (e: IllegalArgumentException) {
            emit(ProviderEvent.Failed(e.message ?: "invalid request", code = "invalid_request"))
            return@flow
        }
        if (offered.isEmpty()) {
            inner.chat(
                request.copy(tools = emptyList(), toolChoice = ToolChoice.Auto, parallelToolCalls = null)
            ).collect { ev ->
                if (ev !is ProviderEvent.NativeToolCalls) emit(ev)
            }
            return@flow
        }
        if (path == ToolPath.NATIVE && !inner.supportsNativeTools(request.model)) {
            emit(ProviderEvent.Failed("provider does not support native tools", code = "native_tools_unsupported"))
            return@flow
        }
        val schema = RequestTranslator.schemaFor(offered)
        var messages = if (path == ToolPath.SHIM) RequestTranslator.prepare(request).messages else request.messages
        var attempt = 0
        while (true) {
            val innerReq = ChatRequest(
                request.model, messages,
                tools = if (path == ToolPath.NATIVE) offered else emptyList(),
                toolChoice = request.toolChoice,
                parallelToolCalls = request.parallelToolCalls,
            )
            val translator = StreamTranslator(schema)
            val nativeCalls = mutableListOf<ToolCall>()
            var finish: String? = null
            var usage: Usage? = null
            var failed: ProviderEvent.Failed? = null
            var protocolError = false
            val streamed = StringBuilder()
            inner.chat(innerReq).collect { ev ->
                    when (ev) {
                        is ProviderEvent.TextDelta -> {
                            if (finish != null) protocolError = true
                            else if (path == ToolPath.SHIM) {
                                val out = translator.feed(ev.text)
                                if (out.isNotEmpty()) {
                                    streamed.append(out)
                                    emit(ProviderEvent.TextDelta(out))
                                }
                            } else {
                                streamed.append(ev.text)
                                emit(ev)
                            }
                        }
                        is ProviderEvent.ReasoningDelta -> {
                            if (finish != null) protocolError = true else emit(ev)
                        }
                        is ProviderEvent.NativeToolCalls -> {
                            if (finish != null) {
                                protocolError = true
                            } else {
                                for (raw in ev.calls) {
                                    try {
                                        nativeCalls.addAll(ToolCallParser.repairNativeCall(raw, schema))
                                    } catch (e: ToolCallParseException) {
                                        failed = ProviderEvent.Failed("invalid_tool_call", e, "invalid_tool_call")
                                    }
                                }
                            }
                        }
                        is ProviderEvent.ToolCalls -> {
                            protocolError = true
                        }
                        is ProviderEvent.Completed -> {
                            if (finish != null) protocolError = true
                            finish = ev.finishReason
                            usage = ev.usage
                        }
                        is ProviderEvent.Failed -> {
                            if (finish != null) protocolError = true else failed = ev
                        }
                    }
            }
            if (protocolError) {
                emit(ProviderEvent.Failed("provider emitted events after completion", code = "protocol_error"))
                return@flow
            }
            if (failed != null) {
                emit(failed!!)
                return@flow
            }
            if (finish == null) {
                emit(ProviderEvent.Failed("stream ended before completion", code = "incomplete_stream"))
                return@flow
            }
            if (finish == "length" || finish == "content_filter") {
                val held = translator.finish(finish).clean
                if (held.isNotEmpty()) emit(ProviderEvent.TextDelta(held))
                emit(ProviderEvent.Completed(finish, usage))
                return@flow
            }
            val result = translator.finish(finish)
            if (result.clean.isNotEmpty()) {
                streamed.append(result.clean)
                emit(ProviderEvent.TextDelta(result.clean))
            }
            if (result.reasoning != null) emit(ProviderEvent.ReasoningDelta(result.reasoning))
            val calls = nativeCalls + result.calls
            val content = streamed.toString()
            if (attempt < retries && path == ToolPath.SHIM &&
                (RequestTranslator.needsRetry(content, calls, true) ||
                    (RequestTranslator.toolCallsRequired(request) && calls.isEmpty()))
            ) {
                attempt++
                messages = RequestTranslator.mergeMessages(messages + RequestTranslator.retryNudge(request.model))
                continue
            }
            val policyError = RequestTranslator.toolPolicyError(calls, request)
            if (policyError != null) {
                emit(ProviderEvent.Failed(policyError, code = "tool_policy_violation"))
                return@flow
            }
            if (RequestTranslator.isEmptyTurn(content, calls, true)) {
                emit(ProviderEvent.Failed("model ended the turn with no answer and no tool call", code = "empty_turn"))
                return@flow
            }
            if (calls.isNotEmpty()) emit(ProviderEvent.ToolCalls(calls))
            emit(ProviderEvent.Completed(if (calls.isNotEmpty()) "tool_calls" else finish, usage))
            return@flow
        }
    }

}

object ToolPaths {
    fun resolve(provider: ModelProvider, model: String, override: ToolPath?): ToolPath {
        if (override == ToolPath.NATIVE && !provider.supportsNativeTools(model)) {
            throw IllegalArgumentException("native tools unsupported for $model")
        }
        return override ?: if (provider.supportsNativeTools(model)) ToolPath.NATIVE else ToolPath.SHIM
    }
}

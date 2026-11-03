package com.adb.stewart.shim

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.provider.ModelInfo
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ProviderEvent
import com.adb.stewart.provider.RawToolCall
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.ToolChoice
import com.adb.stewart.provider.ToolPath
import com.adb.stewart.provider.Usage
import com.adb.stewart.settings.ToolPathResolver
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

class ToolCallingProvider(
    private val inner: ModelProvider,
    private val path: ToolPath,
    private val retries: Int = 1,
) : ModelProvider {

    override val id: String = inner.id

    override suspend fun listModels(): List<ModelInfo> = inner.listModels()

    override fun supportsNativeTools(model: String): Boolean = inner.supportsNativeTools(model)

    override fun supportsImages(model: String): Boolean = inner.supportsImages(model)

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
                when {
                    ev is ProviderEvent.NativeToolCalls -> {}
                    // No tools were offered, so dropped native calls must not end the turn as "tool_calls".
                    ev is ProviderEvent.Completed && ev.finishReason == "tool_calls" -> emit(ev.copy(finishReason = "stop"))
                    else -> emit(ev)
                }
            }
            return@flow
        }
        // A NATIVE path for a native-capable provider is authoritative (it may come from a forced override
        // before capabilities are known); the upstream rejects truly unsupported models itself.
        if (path == ToolPath.NATIVE && inner.id !in ToolPathResolver.NATIVE_CAPABLE &&
            !inner.supportsNativeTools(request.model)
        ) {
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
                                        val unknown = unknownToolCall(raw, schema)
                                        if (unknown != null) nativeCalls.add(unknown)
                                        else failed = ProviderEvent.Failed("invalid_tool_call", e, "invalid_tool_call")
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
            // A model may emit the same call natively and as text (e.g. Claude on the shim path): run it once.
            val nativeKeys = nativeCalls.map { it.name to it.arguments }.toSet()
            val calls = nativeCalls + result.calls.filter { (it.name to it.arguments) !in nativeKeys }
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

    /**
     * A well-formed call to a tool that was not offered (e.g. Claude inventing `bash`) is passed on so
     * the tool loop answers it with an "unknown tool" result and the model can recover; a malformed
     * call to an offered tool is still an invalid_tool_call.
     */
    private fun unknownToolCall(raw: RawToolCall, schema: Map<String, JsonObject>): ToolCall? {
        if (raw.name in schema || !TOOL_NAME.matches(raw.name)) return null
        val args = try {
            Json.parseToJsonElement(raw.arguments.ifBlank { "{}" }) as? JsonObject
        } catch (e: Exception) {
            null
        } ?: return null
        return ToolCall(raw.id?.takeIf { it.isNotBlank() } ?: ToolCallParser.newCallId(), raw.name, args)
    }

    private companion object {
        val TOOL_NAME = Regex("[A-Za-z0-9_.:-]{1,128}")
    }
}

/** Same rule as [ToolPathResolver], for callers holding a typed override instead of the settings map. */
object ToolPaths {
    fun resolve(provider: ModelProvider, model: String, override: ToolPath?): ToolPath {
        val ref = ModelRef(provider.id, model)
        return ToolPathResolver.resolve(ref, provider, override?.let { mapOf(ref.encode() to it.name) } ?: emptyMap())
    }
}

package com.aijb.assistant

import com.aijb.assistant.provider.ChatMessage
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolChoice
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.shim.RequestTranslator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ShimTest {

    private fun spec(name: String) = ToolSpec(name, "desc $name", buildJsonObject {
        put("type", "object")
    })

    private fun req(
        messages: List<ChatMessage>, tools: List<ToolSpec> = emptyList(),
        choice: ToolChoice = ToolChoice.Auto, parallel: Boolean? = null, model: String = "m",
    ) = ChatRequest(model, messages, tools, choice, parallel)

    private fun user(t: String) = ChatMessage(Role.USER, t)
    private fun sys(t: String) = ChatMessage(Role.SYSTEM, t)

    @Test
    fun `call tag per model`() {
        assertEquals("call", RequestTranslator.callTag("glm-5-3-flash"))
        assertEquals("call", RequestTranslator.callTag("GLM-4.6"))
        assertEquals("tool_call", RequestTranslator.callTag("qwen3-8-27b"))
        assertEquals("tool_call", RequestTranslator.callTag(null))
    }

    @Test
    fun `tools injected into system message`() {
        val out = RequestTranslator.prepare(req(listOf(sys("You are helpful."), user("hi")), listOf(spec("read_file"))))
        assertTrue(out.tools.isEmpty())
        assertTrue(out.messages[0].content.startsWith("You are helpful.\n\n# Tools"))
        assertTrue(out.messages[0].content.contains("\"name\":\"read_file\""))
    }

    @Test
    fun `tools injected without system`() {
        val out = RequestTranslator.prepare(req(listOf(user("hi")), listOf(spec("read_file"))))
        assertEquals(Role.SYSTEM, out.messages[0].role)
        assertTrue(out.messages[0].content.startsWith("# Tools"))
    }

    @Test
    fun `tool choice none injects no tools`() {
        val out = RequestTranslator.prepare(req(listOf(user("hi")), listOf(spec("t")), ToolChoice.None))
        assertEquals(1, out.messages.size)
    }

    @Test
    fun `tool choice forced selects only that`() {
        val out = RequestTranslator.prepare(
            req(listOf(user("hi")), listOf(spec("read_file"), spec("list_files")), ToolChoice.Function("list_files")))
        assertTrue(out.messages[0].content.contains("list_files"))
        assertFalse(out.messages[0].content.contains("read_file"))
    }

    @Test
    fun `tool choice invalid rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            RequestTranslator.offeredTools(req(emptyList(), listOf(spec("t")), ToolChoice.Function("missing")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RequestTranslator.offeredTools(req(emptyList(), emptyList(), ToolChoice.Required))
        }
    }

    @Test
    fun `offered tools defaults`() {
        assertEquals(1, RequestTranslator.offeredTools(req(emptyList(), listOf(spec("t")))).size)
        assertTrue(RequestTranslator.offeredTools(req(emptyList(), listOf(spec("t")), ToolChoice.None)).isEmpty())
        assertTrue(RequestTranslator.offeredTools(req(emptyList())).isEmpty())
    }

    @Test
    fun `tool policy error`() {
        val r = req(emptyList(), listOf(spec("t")), ToolChoice.Required)
        assertEquals("Upstream did not return the required tool call.", RequestTranslator.toolPolicyError(emptyList(), r))
        val call = ToolCall("c", "t", JsonObject(emptyMap()))
        assertEquals(null, RequestTranslator.toolPolicyError(listOf(call), r))
        val nopar = req(emptyList(), listOf(spec("t")), ToolChoice.Auto, parallel = false)
        assertEquals(
            "Upstream returned multiple tool calls when parallel_tool_calls is false.",
            RequestTranslator.toolPolicyError(listOf(call, call), nopar))
        assertEquals(null, RequestTranslator.toolPolicyError(listOf(call), nopar))
        assertEquals(null, RequestTranslator.toolPolicyError(emptyList(), nopar))
    }

    @Test
    fun `history rewrite and merge`() {
        val out = RequestTranslator.prepare(req(listOf(
            user("go"),
            ChatMessage(Role.ASSISTANT, "checking", toolCalls = listOf(
                ToolCall("call_1", "read_file", buildJsonObject { put("path", "a.py") }))),
            ChatMessage(Role.TOOL, "file text", toolCallId = "call_1"),
            user("and?"),
        ), listOf(spec("read_file"))))
        val msgs = out.messages
        assertEquals(Role.ASSISTANT, msgs[2].role)
        assertTrue(msgs[2].content.contains("checking"))
        assertTrue(msgs[2].content.contains("<tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.py\"}}\n</tool_call>"))
        assertEquals(Role.USER, msgs[3].role)
        assertTrue(msgs[3].content.startsWith("<tool_response>"))
        assertTrue(msgs[3].content.contains("read_file") && msgs[3].content.contains("file text"))
        assertTrue(msgs[3].content.endsWith("and?"))
    }

    @Test
    fun `tool message unknown call id`() {
        val out = RequestTranslator.prepare(req(listOf(
            ChatMessage(Role.TOOL, "x", toolCallId = "nope"))))
        assertTrue(out.messages[0].content.contains("\"name\":\"unknown\""))
    }

    @Test
    fun `needs retry cases`() {
        val schema = true
        assertTrue(RequestTranslator.needsRetry("", emptyList(), schema))
        assertTrue(RequestTranslator.needsRetry("I have the code context. Let me check the plan doc format and the auth controller to ground the plan.", emptyList(), schema))
        assertTrue(RequestTranslator.needsRetry("I'll gather context on the existing password reset flow and any password-check patterns before writing the plan.", emptyList(), schema))
        assertTrue(RequestTranslator.needsRetry("Done with the review.\n\nNow I will search the codebase:", emptyList(), schema))
        assertFalse(RequestTranslator.needsRetry("The check lives in auth.py.", emptyList(), schema))
        assertFalse(RequestTranslator.needsRetry("Let me know if you want more detail.", emptyList(), schema))
        assertFalse(RequestTranslator.needsRetry("Should I proceed? Let me know.", emptyList(), schema))
        val call = listOf(ToolCall("c", "t", JsonObject(emptyMap())))
        assertFalse(RequestTranslator.needsRetry("", call, schema))
        assertFalse(RequestTranslator.needsRetry("Let me check.", call, schema))
        assertTrue(RequestTranslator.needsRetry("<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"docs/feat\n</tool_call>", emptyList(), schema))
        assertTrue(RequestTranslator.needsRetry("Reading it now.\n<function=read_file>\n<parameter=path>", emptyList(), schema))
        assertFalse(RequestTranslator.needsRetry("<tool_call>{\"name\": \"read_file\"}</tool_call>", call, schema))
        assertFalse(RequestTranslator.needsRetry("", emptyList(), false))
        assertFalse(RequestTranslator.needsRetry("I'll summarise it below.", emptyList(), false))
    }

    @Test
    fun `empty turn`() {
        assertTrue(RequestTranslator.isEmptyTurn("", emptyList(), true))
        assertFalse(RequestTranslator.isEmptyTurn("x", emptyList(), true))
        assertFalse(RequestTranslator.isEmptyTurn("", listOf(ToolCall("c", "t", JsonObject(emptyMap()))), true))
        assertFalse(RequestTranslator.isEmptyTurn("", emptyList(), false))
    }

    @Test
    fun `retry nudge merged and tagged`() {
        val nudge = RequestTranslator.retryNudge("glm-5-3-flash")
        assertTrue(nudge.content.contains("<call>"))
        assertFalse(nudge.content.contains("tool_call"))
        val merged = RequestTranslator.mergeMessages(
            listOf(user("continue"), nudge.copy(role = Role.USER)))
        assertEquals(1, merged.size)
        assertTrue(merged[0].content.startsWith("continue\n\nYour last reply ended without a tool call"))
        val qwen = RequestTranslator.retryNudge("qwen3-8-27b")
        assertTrue(qwen.content.contains("<tool_call>"))
    }

    @Test
    fun `glm request uses call tag`() {
        val out = RequestTranslator.prepare(req(listOf(
            sys("s"), user("go"),
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                ToolCall("call_1", "read_file", buildJsonObject { put("path", "a.py") }))),
            ChatMessage(Role.TOOL, "file text", toolCallId = "call_1"),
        ), listOf(spec("read_file")), model = "glm-5-3-flash"))
        val text = out.messages.joinToString("") { it.content }
        assertFalse(text.contains("tool_call>"))
        assertTrue(out.messages[2].content == "<call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.py\"}}\n</call>")
    }

    @Test
    fun `parallel tool results merged`() {
        val out = RequestTranslator.prepare(req(listOf(
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(
                ToolCall("call_1", "read_file", JsonObject(emptyMap())),
                ToolCall("call_2", "list_files", JsonObject(emptyMap())))),
            ChatMessage(Role.TOOL, "ra", toolCallId = "call_1"),
            ChatMessage(Role.TOOL, "rb", toolCallId = "call_2"),
            user("ok"),
        )))
        assertEquals(2, out.messages.size)
        assertEquals(2, Regex("<tool_call>").findAll(out.messages[0].content).count())
        assertEquals(2, Regex("<tool_response>").findAll(out.messages[1].content).count())
        assertTrue(out.messages[1].content.endsWith("ok"))
    }

    @Test
    fun `translator edge cases`() {
        assertEquals("tool_call", RequestTranslator.callTag(""))
        val block = RequestTranslator.toolBlock(listOf(spec("a"), spec("b")), "tool_call")
        assertTrue(block.contains("\"name\":\"a\"") && block.contains("\"name\":\"b\""))
        val out = RequestTranslator.prepare(req(listOf(
            ChatMessage(Role.ASSISTANT, "plain"),
            ChatMessage(Role.TOOL, "t", toolCallId = "zzz"),
            ChatMessage(Role.ASSISTANT, "after"))))
        assertTrue(out.messages.any { it.content.contains("\"name\":\"unknown\"") })
        val merged = RequestTranslator.mergeMessages(listOf(
            user("a"), sys("s"), user("b")))
        assertEquals(3, merged.size)
    }
}

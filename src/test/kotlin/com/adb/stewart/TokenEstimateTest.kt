package com.adb.stewart

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.chat.TokenEstimate
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenEstimateTest {

    @Test
    fun `empty is zero`() {
        assertEquals(0, TokenEstimate.of(emptyList()))
    }

    @Test
    fun `content only`() {
        val m = ChatMessage(Role.USER, "x".repeat(40))
        assertEquals((40 + 16 + 3) / 4, TokenEstimate.of(listOf(m)))
    }

    @Test
    fun `tool call args counted`() {
        val call = ToolCall("c1", "run", JsonObject(mapOf("a" to JsonPrimitive(1))))
        val argsLen = call.arguments.toString().length
        val m = ChatMessage(Role.ASSISTANT, "abcd", toolCalls = listOf(call))
        assertEquals((4 + "run".length + argsLen + 16 + 3) / 4, TokenEstimate.of(listOf(m)))
        val bare = ChatMessage(Role.ASSISTANT, "abcd")
        assertTrue(TokenEstimate.of(listOf(m)) > TokenEstimate.of(listOf(bare)))
    }

    @Test
    fun `each image adds 1500 tokens`() {
        val img = ImageAttachment("image/png", byteArrayOf(1), "a.png")
        val base = TokenEstimate.of(listOf(ChatMessage(Role.USER, "hi")))
        assertEquals(base + 3000, TokenEstimate.of(listOf(ChatMessage(Role.USER, "hi", images = listOf(img, img)))))
        assertEquals(1500, TokenEstimate.IMAGE_TOKENS)
    }
}

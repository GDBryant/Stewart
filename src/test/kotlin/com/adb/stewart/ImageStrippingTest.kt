package com.adb.stewart

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.chat.stripImages
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageStrippingTest {
    private val a = ImageAttachment("image/png", byteArrayOf(1), "a.png")
    private val b = ImageAttachment("image/png", byteArrayOf(2), "b.png")

    @Test
    fun `images become placeholders appended to content`() {
        val out = stripImages(listOf(ChatMessage(Role.USER, "look", images = listOf(a, b))))
        assertEquals("look\n[image: a.png]\n[image: b.png]", out[0].content)
        assertTrue(out[0].images.isEmpty())
    }

    @Test
    fun `blank content becomes just the placeholder`() {
        assertEquals("[image: a.png]", stripImages(listOf(ChatMessage(Role.USER, "", images = listOf(a))))[0].content)
    }

    @Test
    fun `other fields are preserved`() {
        val call = ToolCall("c1", "t", JsonObject(emptyMap()))
        val m = ChatMessage(Role.TOOL, "r", toolCalls = listOf(call), toolCallId = "c1", images = listOf(a))
        val out = stripImages(listOf(m))[0]
        assertEquals(Role.TOOL, out.role)
        assertEquals(listOf(call), out.toolCalls)
        assertEquals("c1", out.toolCallId)
    }

    @Test
    fun `messages without images are returned unchanged`() {
        val m = ChatMessage(Role.USER, "plain")
        assertSame(m, stripImages(listOf(m))[0])
    }
}

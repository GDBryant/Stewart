package com.aijb.assistant

import com.aijb.assistant.chat.CommandContext
import com.aijb.assistant.chat.SlashCommands
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SlashCommandsTest {

    private class FakeContext(override var running: Boolean = false) : CommandContext {
        val shown = mutableListOf<String>()
        val errors = mutableListOf<String>()
        override fun show(text: String) {
            shown += text
        }
        override fun error(text: String) {
            errors += text
        }
    }

    @Test
    fun `parse splits name and args`() {
        assertEquals(SlashCommands.Parsed("compact", "keep the api notes"), SlashCommands.parse("/compact keep the api notes"))
    }

    @Test
    fun `parse trims extra whitespace around args`() {
        assertEquals(SlashCommands.Parsed("model", "a/b"), SlashCommands.parse("/model   a/b  \n"))
        assertEquals(SlashCommands.Parsed("help", ""), SlashCommands.parse("/help"))
        assertEquals(SlashCommands.Parsed("help", ""), SlashCommands.parse("/help\n"))
    }

    @Test
    fun `parse lowercases the name but not the args`() {
        assertEquals(SlashCommands.Parsed("help", "X"), SlashCommands.parse("/HeLp X"))
    }

    @Test
    fun `leading whitespace double slash and mid text slash are not commands`() {
        assertNull(SlashCommands.parse(" /help"))
        assertNull(SlashCommands.parse("//help"))
        assertNull(SlashCommands.parse("see a/b and /help"))
        assertNull(SlashCommands.parse(""))
    }

    @Test
    fun `double slash escapes to a single slash and other text is unchanged`() {
        assertEquals("/help me", SlashCommands.plainText("//help me"))
        assertEquals("a /b", SlashCommands.plainText("a /b"))
        assertEquals(" /x", SlashCommands.plainText(" /x"))
    }

    @Test
    fun `a lone slash is an unknown command`() {
        val parsed = SlashCommands.parse("/")!!
        assertEquals("", parsed.name)
        val ctx = FakeContext()
        assertFalse(SlashCommands.execute(parsed, ctx))
        assertEquals(listOf("Unknown command / — type /help"), ctx.errors)
    }

    @Test
    fun `unknown command reports an error and shows nothing`() {
        val ctx = FakeContext()
        assertFalse(SlashCommands.execute(SlashCommands.parse("/nope x")!!, ctx))
        assertEquals(listOf("Unknown command /nope — type /help"), ctx.errors)
        assertTrue(ctx.shown.isEmpty())
    }

    @Test
    fun `help lists every registered command`() {
        val ctx = FakeContext()
        assertTrue(SlashCommands.execute(SlashCommands.parse("/help")!!, ctx))
        val text = ctx.shown.single()
        SlashCommands.all.forEach { assertTrue(it.name, text.contains("/${it.name}")) }
        assertTrue(ctx.errors.isEmpty())
    }

    @Test
    fun `help runs while a run is active`() {
        val ctx = FakeContext(running = true)
        assertTrue(SlashCommands.execute(SlashCommands.parse("/help")!!, ctx))
        assertEquals(1, ctx.shown.size)
    }

    @Test
    fun `find returns null for an unknown name`() {
        assertNull(SlashCommands.find("nope"))
        assertEquals("help", SlashCommands.find("help")!!.name)
    }
}

package com.adb.stewart

import com.adb.stewart.agents.continueOptions
import com.adb.stewart.agents.continueQuestionText
import com.adb.stewart.agents.detectStuck
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FaultRecoveryContinueTest {
    private var n = 0
    /** One assistant turn with a call plus its result. */
    private fun turn(name: String, key: String = "path", value: String = "f${n}", result: String = "ok"): List<ChatMessage> {
        val id = "c${n++}"
        return listOf(
            ChatMessage(Role.ASSISTANT, "", toolCalls = listOf(ToolCall(id, name, buildJsonObject { put(key, value) }))),
            ChatMessage(Role.TOOL, result, toolCallId = id),
        )
    }

    @Test fun `empty history not stuck`() = assertNull(detectStuck(emptyList()))

    @Test fun `two identical calls not stuck`() {
        val m = turn("EditFile", value = "a") + turn("EditFile", value = "a")
        assertNull(detectStuck(m))
    }

    @Test fun `three identical calls stuck`() {
        val m = (1..3).flatMap { turn("ReadFile", value = "a") }
        assertTrue(detectStuck(m)!!.contains("ReadFile"))
    }

    @Test fun `same tool different args not a repeat`() {
        val m = (1..3).flatMap { turn("EditFile") }
        assertNull(detectStuck(m))
    }

    @Test fun `five reads without progress stuck`() {
        val m = (1..5).flatMap { turn("ReadFile") }
        assertTrue(detectStuck(m)!!.contains("last 5"))
    }

    @Test fun `five turns with a successful edit not stuck`() {
        val m = (1..4).flatMap { turn("ReadFile") } + turn("EditFile")
        assertNull(detectStuck(m))
    }

    @Test fun `failed edits do not count as progress`() {
        val m = (1..2).flatMap { turn("ReadFile") } + turn("EditFile", result = "Error: no match") +
            turn("WriteFile", result = "Rejected by user: no") + turn("RunTerminal", key = "command", result = "Invalid tool call: x")
        assertTrue(detectStuck(m) != null)
    }

    @Test fun `old edit outside last five turns does not count`() {
        val m = turn("EditFile") + (1..5).flatMap { turn("ReadFile") }
        assertTrue(detectStuck(m) != null)
    }

    @Test fun `fewer than five turns without progress not stuck`() {
        assertNull(detectStuck((1..4).flatMap { turn("ReadFile") }))
    }

    @Test fun `terminal success is progress`() {
        val m = (1..4).flatMap { turn("ReadFile") } + turn("RunTerminal", key = "command", value = "ls")
        assertNull(detectStuck(m))
    }

    @Test fun `options order`() {
        assertEquals(listOf("Continue (+10 turns)", "Split into smaller tasks", "Stop this task"), continueOptions(false, 10, true))
        assertEquals(listOf("Split into smaller tasks", "Continue (+10 turns)", "Stop this task"), continueOptions(true, 10, true))
        assertEquals(listOf("Continue (+10 turns)", "Stop this task"), continueOptions(true, 10, false))
    }

    @Test fun `text follows template`() {
        val m = turn("EditFile", value = "a.kt") + turn("RunTerminal", key = "command", value = "gradle test") +
            turn("ReadFile", value = "bad", result = "Error: nope")
        val t = continueQuestionText(25, "t1", "Fix it", m, null, 25)
        assertTrue(t, t.startsWith("Worker hit its turn limit (25) on task t1: \"Fix it\"."))
        assertTrue(t, t.contains("Done so far: EditFile a.kt; RunTerminal gradle test."))
        assertTrue(t, t.contains("Last action: ReadFile bad."))
        assertTrue(t, !t.contains("Looks stuck"))
        assertTrue(t, t.endsWith("Options: Continue (+25 turns) · Split into smaller tasks · Stop this task"))
    }

    @Test fun `stuck line and split first`() {
        val t = continueQuestionText(5, "t", "d", emptyList(), "looping", 5)
        assertTrue(t, t.contains("Done so far: nothing yet. Last action: none."))
        assertTrue(t, t.contains("Looks stuck: looping"))
        assertTrue(t, t.contains("Options: Split into smaller tasks · Continue"))
    }

    @Test fun `no split in plain chat`() {
        val t = continueQuestionText(5, "t", "d", emptyList(), null, 5, withSplit = false)
        assertTrue(t, !t.contains("Split"))
    }

    @Test fun `caps description actions and total`() {
        val m = (1..9).flatMap { turn("EditFile", value = "x".repeat(300) + it) }
        val t = continueQuestionText(5, "t", "d".repeat(500), m, "r".repeat(400), 5)
        assertTrue(t, !t.contains("d".repeat(121)))
        assertEquals(5, Regex("EditFile ").findAll(t).count() - 1) // last action also listed
        assertTrue(t.length <= 600)
        assertTrue(t, t.endsWith("Stop this task"))
    }

    @Test fun `plain chat has its own wording`() {
        val t = continueQuestionText(25, "chat", "refactor it", emptyList(), null, 25, withSplit = false, plainChat = true)
        assertTrue(t, t.startsWith("Hit the tool-turn limit (25) on: \"refactor it\".\n"))
        assertTrue(t, !t.contains("Worker hit"))
        assertTrue(t, !t.contains("task chat"))
        assertTrue(t, t.endsWith("Options: Continue (+25 turns) · Stop this task"))
    }

    @Test fun `worker wording unchanged by default`() {
        val t = continueQuestionText(25, "t1", "Fix it", emptyList(), null, 25)
        assertTrue(t, t.startsWith("Worker hit its turn limit (25) on task t1:"))
    }
}

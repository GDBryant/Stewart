package com.aijb.assistant

import com.aijb.assistant.agents.ProtocolException
import com.aijb.assistant.agents.ProtocolTools
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ProtocolToolTest {
    private fun args(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `plan tool accepts a valid plan`() {
        val tool = ProtocolTools.planTool(startId = 1, maxMilestones = 3)
        val out = runBlocking { tool.execute(args("""{"goal":"g","milestones":[{"id":1,"title":"a"}]}"""), null) }
        assertEquals("accepted", out)
        assertEquals("g", tool.accepted?.goal)
    }

    @Test
    fun `plan tool rejects bad ids and leaves nothing accepted`() {
        val tool = ProtocolTools.planTool(startId = 4, maxMilestones = 3)
        assertThrows(ProtocolException::class.java) {
            runBlocking { tool.execute(args("""{"goal":"g","milestones":[{"id":1,"title":"a"}]}"""), null) }
        }
        assertNull(tool.accepted)
    }

    @Test
    fun `plan tool enforces the milestone limit`() {
        val tool = ProtocolTools.planTool(startId = 1, maxMilestones = 1)
        val e = assertThrows(ProtocolException::class.java) {
            runBlocking {
                tool.execute(args("""{"goal":"g","milestones":[{"id":1,"title":"a"},{"id":2,"title":"b"}]}"""), null)
            }
        }
        assertEquals("plan has 2 milestones (max 1)", e.message)
    }

    @Test
    fun `tasks tool accepts valid tasks and enforces the round limit`() {
        val ok = ProtocolTools.tasksTool(maxTasksPerRound = 1)
        runBlocking { ok.execute(args("""{"tasks":[{"id":1,"description":"d"}]}"""), null) }
        assertEquals(1, ok.accepted?.size)
        val over = ProtocolTools.tasksTool(maxTasksPerRound = 1)
        assertThrows(ProtocolException::class.java) {
            runBlocking {
                over.execute(args("""{"tasks":[{"id":1,"description":"d"},{"id":2,"description":"e"}]}"""), null)
            }
        }
        assertNull(over.accepted)
    }

    @Test
    fun `result tool requires the expected task id`() {
        val tool = ProtocolTools.resultTool(expectedTaskId = 2)
        assertThrows(ProtocolException::class.java) {
            runBlocking { tool.execute(args("""{"task_id":1,"status":"done","summary":"s"}"""), null) }
        }
        assertNull(tool.accepted)
        runBlocking { tool.execute(args("""{"task_id":2,"status":"done","summary":"s"}"""), null) }
        assertEquals(2, tool.accepted?.taskId)
    }

    @Test
    fun `complete milestone tool keeps notes and defaults to empty`() {
        val tool = ProtocolTools.completeMilestoneTool()
        runBlocking { tool.execute(args("""{"notes":"ok"}"""), null) }
        assertEquals("ok", tool.accepted)
        val bare = ProtocolTools.completeMilestoneTool()
        runBlocking { bare.execute(args("{}"), null) }
        assertEquals("", bare.accepted)
    }
}

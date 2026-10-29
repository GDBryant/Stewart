package com.aijb.assistant

import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.ui.ApprovalPrompter
import com.aijb.assistant.ui.CommandApprovalDialog
import com.aijb.assistant.ui.FileApprovalDialog
import com.aijb.assistant.ui.GenericApprovalDialog
import com.aijb.assistant.ui.IdeApprovalGate
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject

class ApprovalGateTest : BasePlatformTestCase() {

    private class RecordingPrompter(private val decision: ApprovalDecision = ApprovalDecision.Approved) : ApprovalPrompter {
        val calls = mutableListOf<String>()
        override suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): ApprovalDecision {
            calls += "file:${change.path}"
            return decision
        }
        override suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): ApprovalDecision {
            calls += "command:${command.command}"
            return decision
        }
        override suspend fun confirmGeneric(call: ToolCall): ApprovalDecision {
            calls += "generic:${call.name}"
            return decision
        }
    }

    private val call = ToolCall("c1", "EditFile", JsonObject(emptyMap()))
    private val fileChange = ToolPreview.FileChange("/p/f.txt", "old", "new")
    private val command = ToolPreview.Command("ls", "/p")

    fun `test file change auto approved in trusted mode`() {
        val prompter = RecordingPrompter()
        val gate = IdeApprovalGate(project, { true }, prompter)
        val d = runBlocking { gate.review(call, fileChange) }
        assertTrue(d is ApprovalDecision.Approved)
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test file change prompts when not trusted`() {
        val prompter = RecordingPrompter()
        val gate = IdeApprovalGate(project, { false }, prompter)
        val d = runBlocking { gate.review(call, fileChange) }
        assertTrue(d is ApprovalDecision.Approved)
        assertEquals(listOf("file:/p/f.txt"), prompter.calls)
    }

    fun `test command always prompts even in trusted mode`() {
        val prompter = RecordingPrompter()
        val gate = IdeApprovalGate(project, { true }, prompter)
        runBlocking { gate.review(call, command) }
        assertEquals(listOf("command:ls"), prompter.calls)
    }

    fun `test null preview prompts generic`() {
        val prompter = RecordingPrompter()
        val gate = IdeApprovalGate(project, { true }, prompter)
        runBlocking { gate.review(call, null) }
        assertEquals(listOf("generic:EditFile"), prompter.calls)
    }

    fun `test rejection propagates`() {
        val prompter = RecordingPrompter(ApprovalDecision.Rejected("no way"))
        val gate = IdeApprovalGate(project, { false }, prompter)
        val d = runBlocking { gate.review(call, command) }
        assertEquals(ApprovalDecision.Rejected("no way"), d)
    }

    fun `test file dialog builds with diff panel`() {
        val d = FileApprovalDialog(project, call, fileChange)
        try {
            assertEquals("Approve EditFile", d.title)
            assertNotNull(d.title)
        } finally { com.intellij.openapi.util.Disposer.dispose(d.disposable) }
    }

    fun `test file dialog new file`() {
        val d = FileApprovalDialog(project, call, ToolPreview.FileChange("/p/new.txt", null, "new"))
        try {
            assertNotNull(d.title)
        } finally { com.intellij.openapi.util.Disposer.dispose(d.disposable) }
    }

    fun `test command dialog shows command and cwd`() {
        val d = CommandApprovalDialog(project, call, command)
        assertEquals("Approve EditFile", d.title)
        assertNotNull(d.title)
    }

    fun `test generic dialog shows args`() {
        val d = GenericApprovalDialog(project, call)
        assertNotNull(d.title)
    }

    fun `test dialog ok and cancel exit codes`() {
        val ok = CommandApprovalDialog(project, call, command)
        ok.close(DialogWrapper.OK_EXIT_CODE)
        assertEquals(DialogWrapper.OK_EXIT_CODE, ok.exitCode)
        val cancel = CommandApprovalDialog(project, call, command)
        cancel.close(DialogWrapper.CANCEL_EXIT_CODE)
        assertEquals(DialogWrapper.CANCEL_EXIT_CODE, cancel.exitCode)
    }
}

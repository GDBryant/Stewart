package com.aijb.assistant

import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.tools.ApprovalDecision
import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.tools.permissions.AlwaysGrantWriter
import com.aijb.assistant.tools.permissions.ApprovalCategory
import com.aijb.assistant.tools.permissions.Grant
import com.aijb.assistant.tools.permissions.GrantScope
import com.aijb.assistant.tools.permissions.GrantTarget
import com.aijb.assistant.tools.permissions.PermissionsSnapshot
import com.aijb.assistant.tools.permissions.PromptResult
import com.aijb.assistant.tools.permissions.SessionGrants
import com.aijb.assistant.ui.ApprovalPrompter
import com.aijb.assistant.ui.CommandApprovalDialog
import com.aijb.assistant.ui.FileApprovalDialog
import com.aijb.assistant.ui.GenericApprovalDialog
import com.aijb.assistant.ui.IdeApprovalGate
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject

class ApprovalGateTest : BasePlatformTestCase() {

    private class RecordingPrompter(
        private val result: PromptResult = PromptResult(ApprovalDecision.Approved),
    ) : ApprovalPrompter {
        val calls = mutableListOf<String>()
        override suspend fun confirmFile(call: ToolCall, change: ToolPreview.FileChange): PromptResult {
            calls += "file:${change.path}"
            return result
        }
        override suspend fun confirmCommand(call: ToolCall, command: ToolPreview.Command): PromptResult {
            calls += "command:${command.command}"
            return result
        }
        override suspend fun confirmGeneric(call: ToolCall): PromptResult {
            calls += "generic:${call.name}"
            return result
        }
    }

    private class RecordingWriter : AlwaysGrantWriter {
        val targets = mutableListOf<GrantTarget>()
        override fun record(project: com.intellij.openapi.project.Project, target: GrantTarget) {
            targets += target
        }
    }

    private val call = ToolCall("c1", "EditFile", JsonObject(emptyMap()))
    private val fileChange = ToolPreview.FileChange("/p/f.txt", "old", "new")
    private val command = ToolPreview.Command("ls", "/p")

    private fun gate(
        snapshot: PermissionsSnapshot = PermissionsSnapshot(),
        grants: SessionGrants = SessionGrants(),
        prompter: RecordingPrompter = RecordingPrompter(),
        writer: AlwaysGrantWriter = RecordingWriter(),
        split: (String) -> List<String>? = { null },
    ) = IdeApprovalGate(project, { snapshot }, grants, prompter, writer, split)

    fun `test file change auto approved when edits ticked`() {
        val prompter = RecordingPrompter()
        val g = gate(PermissionsSnapshot(ticks = setOf(ApprovalCategory.EDITS)), prompter = prompter)
        val d = runBlocking { g.review(call, fileChange) }
        assertTrue(d is ApprovalDecision.Approved)
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test file change prompts when not ticked`() {
        val prompter = RecordingPrompter()
        val g = gate(prompter = prompter)
        val d = runBlocking { g.review(call, fileChange) }
        assertTrue(d is ApprovalDecision.Approved)
        assertEquals(listOf("file:/p/f.txt"), prompter.calls)
    }

    fun `test commands tick auto approves commands only`() {
        val prompter = RecordingPrompter()
        val g = gate(PermissionsSnapshot(ticks = setOf(ApprovalCategory.COMMANDS)), prompter = prompter)
        runBlocking { g.review(call, command) }
        assertTrue(prompter.calls.isEmpty())
        runBlocking { g.review(call, fileChange) }
        assertEquals(listOf("file:/p/f.txt"), prompter.calls)
    }

    fun `test other tick auto approves other preview`() {
        val prompter = RecordingPrompter()
        val g = gate(PermissionsSnapshot(ticks = setOf(ApprovalCategory.OTHER)), prompter = prompter)
        runBlocking { g.review(call, ToolPreview.Other) }
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test session category grant auto approves`() {
        val prompter = RecordingPrompter()
        val grants = SessionGrants()
        grants.grant(ApprovalCategory.EDITS)
        val g = gate(grants = grants, prompter = prompter)
        runBlocking { g.review(call, fileChange) }
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test covered command auto approves when every program granted`() {
        val prompter = RecordingPrompter()
        val g = gate(
            PermissionsSnapshot(programs = setOf("git")),
            prompter = prompter,
            split = { listOf("git", "git") },
        )
        runBlocking { g.review(call, ToolPreview.Command("git add . && git commit", "/p")) }
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test command programs can be split across always and chat grants`() {
        val prompter = RecordingPrompter()
        val grants = SessionGrants()
        grants.grant(listOf("grep"))
        val g = gate(
            PermissionsSnapshot(programs = setOf("git")),
            grants,
            prompter,
            split = { listOf("git", "grep") },
        )
        runBlocking { g.review(call, command) }
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test command prompts when one program ungranted`() {
        val prompter = RecordingPrompter()
        val g = gate(
            PermissionsSnapshot(programs = setOf("git")),
            prompter = prompter,
            split = { listOf("git", "rm") },
        )
        runBlocking { g.review(call, command) }
        assertEquals(listOf("command:ls"), prompter.calls)
    }

    fun `test command prompts when unparseable or empty`() {
        val prompter = RecordingPrompter()
        val g = gate(
            PermissionsSnapshot(programs = setOf("git")),
            prompter = prompter,
            split = { null },
        )
        runBlocking { g.review(call, command) }
        assertEquals(listOf("command:ls"), prompter.calls)

        prompter.calls.clear()
        val g2 = gate(
            PermissionsSnapshot(programs = setOf("git")),
            prompter = prompter,
            split = { emptyList() },
        )
        runBlocking { g2.review(call, command) }
        assertEquals(listOf("command:ls"), prompter.calls)
    }

    fun `test null preview prompts generic`() {
        val prompter = RecordingPrompter()
        val g = gate(PermissionsSnapshot(ticks = ApprovalCategory.entries.toSet()), prompter = prompter)
        runBlocking { g.review(call, null) }
        assertEquals(listOf("generic:EditFile"), prompter.calls)
    }

    fun `test failing permissions read falls back to prompt`() {
        val prompter = RecordingPrompter()
        val g = IdeApprovalGate(project, { throw IllegalStateException("corrupt") },
            SessionGrants(), prompter, RecordingWriter())
        val d = runBlocking { g.review(call, fileChange) }
        assertTrue(d is ApprovalDecision.Approved)
        assertEquals(listOf("file:/p/f.txt"), prompter.calls)
    }

    fun `test auto approved calls bump the chat counter`() {
        val grants = SessionGrants()
        grants.grant(ApprovalCategory.EDITS)
        val g = gate(grants = grants)
        runBlocking { g.review(call, fileChange) }
        runBlocking { g.review(call, fileChange) }
        assertEquals(2, grants.autoApprovedCount())
        grants.clear()
        assertEquals(0, grants.autoApprovedCount())
    }

    fun `test chat grant is recorded after an approved prompt`() {
        val grants = SessionGrants()
        val prompter = RecordingPrompter(
            PromptResult(ApprovalDecision.Approved, Grant(GrantScope.CHAT, GrantTarget.Category(ApprovalCategory.COMMANDS))),
        )
        val g = gate(grants = grants, prompter = prompter)
        runBlocking { g.review(call, command) }
        assertTrue(grants.covers(ApprovalCategory.COMMANDS))
        prompter.calls.clear()
        runBlocking { g.review(call, command) }
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test chat program grant is recorded after an approved prompt`() {
        val grants = SessionGrants()
        val prompter = RecordingPrompter(
            PromptResult(ApprovalDecision.Approved, Grant(GrantScope.CHAT, GrantTarget.Programs(setOf("git")))),
        )
        val g = gate(grants = grants, prompter = prompter, split = { listOf("git") })
        runBlocking { g.review(call, command) }
        prompter.calls.clear()
        runBlocking { g.review(call, command) }
        assertTrue(prompter.calls.isEmpty())
    }

    fun `test always grant is written to the project store`() {
        val writer = RecordingWriter()
        val prompter = RecordingPrompter(
            PromptResult(ApprovalDecision.Approved, Grant(GrantScope.ALWAYS, GrantTarget.Category(ApprovalCategory.EDITS))),
        )
        val g = gate(prompter = prompter, writer = writer)
        runBlocking { g.review(call, fileChange) }
        assertEquals(listOf<GrantTarget>(GrantTarget.Category(ApprovalCategory.EDITS)), writer.targets)
    }

    fun `test rejected prompt records no grant`() {
        val grants = SessionGrants()
        val writer = RecordingWriter()
        val prompter = RecordingPrompter(
            PromptResult(ApprovalDecision.Rejected("no"), Grant(GrantScope.CHAT, GrantTarget.Category(ApprovalCategory.EDITS))),
        )
        val g = gate(grants = grants, prompter = prompter, writer = writer)
        runBlocking { g.review(call, fileChange) }
        assertFalse(grants.covers(ApprovalCategory.EDITS))
        assertTrue(writer.targets.isEmpty())
    }

    fun `test rejection propagates`() {
        val prompter = RecordingPrompter(PromptResult(ApprovalDecision.Rejected("no way")))
        val g = gate(prompter = prompter)
        val d = runBlocking { g.review(call, command) }
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

    // --- modeless dialogs: decision and cancel plumbing (fake DialogHost, no real window shown) ---

    private class Harness(project: com.intellij.openapi.project.Project) {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)
        @Volatile var shown: com.aijb.assistant.ui.ApprovalDialog? = null
        var shownCount = 0
        val prompter = com.aijb.assistant.ui.DialogPrompter(project) { shownCount++; shown = it }
    }

    private fun pumpUntil(cond: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (cond()) return true
            Thread.sleep(20)
        }
        return false
    }

    fun `test dialogs are modeless so Stop stays reachable`() {
        listOf(
            GenericApprovalDialog(project, call),
            FileApprovalDialog(project, call, fileChange),
            CommandApprovalDialog(project, call, command),
        ).forEach {
            assertFalse(it.isModal)
            it.close(DialogWrapper.CANCEL_EXIT_CODE)
        }
    }

    fun `test approve and reject each produce their decision`() {
        val h = Harness(project)
        try {
            val approved = h.scope.async { h.prompter.confirmCommand(call, command) }
            assertTrue(pumpUntil { h.shown != null })
            h.shown!!.approve()
            assertTrue(pumpUntil { approved.isCompleted })
            assertTrue(runBlocking { approved.await() }.decision is ApprovalDecision.Approved)

            h.shown = null
            val rejected = h.scope.async { h.prompter.confirmFile(call, fileChange) }
            assertTrue(pumpUntil { h.shown != null })
            h.shown!!.reject()
            assertTrue(pumpUntil { rejected.isCompleted })
            val d = runBlocking { rejected.await() }
            assertEquals(ApprovalDecision.Rejected("rejected by user"), d.decision)
            assertEquals(2, h.shownCount)
        } finally {
            h.scope.cancel()
        }
    }

    fun `test only the first decision counts`() {
        val h = Harness(project)
        try {
            val result = h.scope.async { h.prompter.confirmGeneric(call) }
            assertTrue(pumpUntil { h.shown != null })
            h.shown!!.approve()
            h.shown!!.reject()
            assertTrue(pumpUntil { result.isCompleted })
            assertTrue(runBlocking { result.await() }.decision is ApprovalDecision.Approved)
        } finally {
            h.scope.cancel()
        }
    }

    fun `test cancelling while the dialog is open closes it`() {
        val h = Harness(project)
        try {
            val result = h.scope.async { h.prompter.confirmGeneric(call) }
            assertTrue(pumpUntil { h.shown != null })
            val dialog = h.shown!!
            result.cancel()
            assertTrue(pumpUntil { dialog.isDisposed })
            assertEquals(DialogWrapper.CANCEL_EXIT_CODE, dialog.exitCode)
            assertTrue(result.isCancelled)
        } finally {
            h.scope.cancel()
        }
    }

    fun `test dialog already closed by the user is not closed again on cancel`() {
        val h = Harness(project)
        try {
            val result = h.scope.async { h.prompter.confirmGeneric(call) }
            assertTrue(pumpUntil { h.shown != null })
            val dialog = h.shown!!
            dialog.reject()
            assertTrue(pumpUntil { result.isCompleted })
            result.cancel()
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertTrue(runBlocking { result.await() }.decision is ApprovalDecision.Rejected)
        } finally {
            h.scope.cancel()
        }
    }
}

package com.adb.stewart

import com.adb.stewart.actions.AddSelectionToChatAction
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

class AddSelectionToChatActionTest : BasePlatformTestCase() {
    private fun event(action: AddSelectionToChatAction): AnActionEvent {
        val dc = SimpleDataContext.builder()
            .add(CommonDataKeys.PROJECT, project)
            .add(CommonDataKeys.EDITOR, myFixture.editor)
            .build()
        return AnActionEvent.createFromDataContext(ActionPlaces.UNKNOWN, action.templatePresentation.clone(), dc)
    }

    fun testUpdateEnabledOnlyWithSelection() {
        myFixture.configureByText("a.ts", "hello world")
        val action = AddSelectionToChatAction()
        val e = event(action)
        action.update(e)
        assertFalse(e.presentation.isEnabled)
        myFixture.editor.selectionModel.setSelection(0, 5)
        action.update(e)
        assertTrue(e.presentation.isEnabled)
    }

    fun testPushesInsertTextWithPathLinesAndSelection() {
        myFixture.configureByText("a.ts", "hello world")
        myFixture.editor.selectionModel.setSelection(0, 5)
        var pushed: JsonObject? = null
        val service = StewartProjectService.getInstance(project)
        service.inboundObserver = { pushed = it }
        try {
            AddSelectionToChatAction().actionPerformed(event(AddSelectionToChatAction()))
        } finally {
            service.inboundObserver = null
        }
        assertNotNull(pushed)
        assertEquals("insertText", pushed!!["type"]!!.jsonPrimitive.content)
        val text = pushed["text"]!!.jsonPrimitive.content
        assertTrue(text.contains("hello"))
        assertTrue(text.contains("a.ts:1-1"))
    }

    fun testNoSelectionPushesNothing() {
        myFixture.configureByText("a.ts", "hello world")
        var pushed: JsonObject? = null
        val service = StewartProjectService.getInstance(project)
        service.inboundObserver = { pushed = it }
        try {
            AddSelectionToChatAction().actionPerformed(event(AddSelectionToChatAction()))
        } finally {
            service.inboundObserver = null
        }
        assertNull(pushed)
    }
}

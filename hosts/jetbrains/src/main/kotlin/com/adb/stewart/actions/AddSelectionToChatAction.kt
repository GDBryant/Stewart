package com.adb.stewart.actions

import com.adb.stewart.StewartProjectService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.wm.ToolWindowManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class AddSelectionToChatAction : AnAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val sel = editor.selectionModel.selectedText ?: return
        val abs = editor.virtualFile?.path ?: ""
        val base = project.basePath ?: ""
        val rel = if (base.isNotEmpty() && abs.startsWith("$base/")) abs.removePrefix("$base/") else abs
        val start = editor.document.getLineNumber(editor.selectionModel.selectionStart) + 1
        val end = editor.document.getLineNumber(editor.selectionModel.selectionEnd) + 1
        ToolWindowManager.getInstance(project).getToolWindow("Stewart")?.activate(null)
        StewartProjectService.getInstance(project).pushInbound(
            JsonObject(
                mapOf(
                    "type" to JsonPrimitive("insertText"),
                    "text" to JsonPrimitive("@selection\n```\n// $rel:$start-$end\n$sel\n```\n"),
                ),
            ),
        )
    }
}

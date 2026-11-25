package com.adb.stewart.actions

import com.adb.stewart.StewartProjectService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Restart (or self-heal start) of the Stewart sidecar; re-runs Node resolution,
 *  downloading and caching a Node 22 runtime on first use when none is bundled
 *  or on PATH. */
class RestartAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        StewartProjectService.getInstance(project).restart()
    }
}

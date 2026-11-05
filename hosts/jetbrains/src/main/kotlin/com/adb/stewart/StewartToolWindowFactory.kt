package com.adb.stewart

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

class StewartToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = StewartProjectService.getInstance(project)
        val panelComponent = when {
            Env.isRemoteDev() -> notice("Stewart does not support remote development sessions (Gateway/Code With Me). Open the project in a local IDE.")
            else -> {
                service.ensureStarted()
                val panel = service.createPanel()
                panel.component
            }
        }
        val content = ContentFactory.getInstance().createContent(panelComponent, "", false)
        toolWindow.contentManager.addContent(content)
    }

    private fun notice(text: String): JPanel = JPanel(BorderLayout()).apply {
        add(JLabel("<html><center>$text</center></html>", SwingConstants.CENTER), BorderLayout.CENTER)
    }
}

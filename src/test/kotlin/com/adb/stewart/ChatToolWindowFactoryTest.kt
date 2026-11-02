package com.adb.stewart

import com.adb.stewart.ui.ChatPanel
import com.adb.stewart.ui.ChatToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.toolWindow.ToolWindowHeadlessManagerImpl

class ChatToolWindowFactoryTest : BasePlatformTestCase() {

    fun `test factory adds one chat panel content`() {
        val manager = ToolWindowManager.getInstance(project) as ToolWindowHeadlessManagerImpl
        val toolWindow = manager.doRegisterToolWindow("AIJB Assistant")
        ChatToolWindowFactory().createToolWindowContent(project, toolWindow)
        val contents = toolWindow.contentManager.contents
        assertEquals(1, contents.size)
        assertTrue(contents[0].component is ChatPanel)
        (contents[0].component as ChatPanel).dispose()
    }
}

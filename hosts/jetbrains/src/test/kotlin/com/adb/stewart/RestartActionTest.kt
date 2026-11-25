package com.adb.stewart

import com.adb.stewart.actions.RestartAction
import com.adb.stewart.sidecar.NodeLocator
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.PathManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

class RestartActionTest : BasePlatformTestCase() {
    private fun event(action: RestartAction): AnActionEvent {
        val dc = SimpleDataContext.builder()
            .add(CommonDataKeys.PROJECT, project)
            .build()
        return AnActionEvent.createFromDataContext(ActionPlaces.UNKNOWN, action.templatePresentation.clone(), dc)
    }

    fun testUpdateEnabledWithProject() {
        val action = RestartAction()
        val e = event(action)
        action.update(e)
        assertTrue(e.presentation.isEnabled)
    }

    fun testRestartIsASafeNoOpForTheService() {
        // Pre-seed a fake bundled node so resolution never probes PATH or
        // downloads anything; the (non-executable) "node" then fails to spawn
        // inside the supervisor's handled launch-failure path.
        val k = NodeLocator.osKey(System.getProperty("os.name"), System.getProperty("os.arch"))
            ?: "linux-x64"
        val f = File(File(PathManager.getConfigPath(), "stewart/runtime/node/$k"), "node")
        f.parentFile.mkdirs()
        f.writeText("fake")

        // Restart (re)runs Node resolution and (re)starts the sidecar; in a
        // headless test JVM that must not throw and leaves the service usable.
        val service = StewartProjectService.getInstance(project)
        RestartAction().actionPerformed(event(RestartAction()))
        assertTrue(service.projectId.isNotEmpty())
    }
}

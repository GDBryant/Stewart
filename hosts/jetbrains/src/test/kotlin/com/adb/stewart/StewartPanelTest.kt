package com.adb.stewart

import com.adb.stewart.webview.StewartPanel
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.jcef.JBCefApp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import javax.swing.JLabel

class StewartPanelTest : BasePlatformTestCase() {
    fun testFallbackWhenJcefUnsupported() {
        if (JBCefApp.isSupported()) return
        val p = StewartPanel(File("index.html")) {}
        val label = p.component.components.filterIsInstance<JLabel>().firstOrNull()
        assertNotNull(label)
        assertTrue(label!!.text.contains("JCEF"))
        p.pushInbound(JsonObject(mapOf("type" to JsonPrimitive("ready"))))
        p.dispose()
    }
}

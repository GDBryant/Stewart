package com.adb.stewart.e2e

import com.adb.stewart.webview.StewartPanel
import com.adb.stewart.webview.ThemeColors
import com.adb.stewart.webview.ThemeCss
import com.adb.stewart.webview.WebviewResources
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.jcef.JBCefApp
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.ConcurrentLinkedQueue

class WebviewE2ETest : BasePlatformTestCase() {
    private fun awaitMessage(queue: ConcurrentLinkedQueue<String>, type: String, timeoutMs: Long = 30_000): JsonObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            queue.firstOrNull { it.contains("\"type\":\"$type\"") }?.let { queue.remove(it); return Json.parseToJsonElement(it).jsonObject }
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(50)
        }
        fail("no '$type' message from the webview within ${timeoutMs}ms; got: ${queue.toList()}")
        throw IllegalStateException()
    }

    fun testWebviewRendersAndBridgeReachesHost() {
        assertTrue("JCEF unavailable: run under a display or with -Dide.browser.jcef.headless.enabled=true", JBCefApp.isSupported())
        val outbound = ConcurrentLinkedQueue<String>()
        val panel = StewartPanel({ bridge -> WebviewResources.webviewHtml(bridge) }) { outbound.add(it) }
        try {
            awaitMessage(outbound, "ready")
            panel.runScript(
                "window.stewartHost.post(JSON.stringify({type:'probe'," +
                    "tabs:!!document.querySelector('.tabs')," +
                    "composer:!!document.querySelector('textarea')}));",
            )
            val probe = awaitMessage(outbound, "probe")
            assertTrue("tab bar missing", probe["tabs"]!!.jsonPrimitive.boolean)
            assertTrue("chat input missing", probe["composer"]!!.jsonPrimitive.boolean)
        } finally {
            panel.dispose()
        }
    }

    fun testThemeCssAppliedAndUpdated() {
        assertTrue("JCEF unavailable: run under a display or with -Dide.browser.jcef.headless.enabled=true", JBCefApp.isSupported())
        val dark = ThemeCss.css(
            ThemeColors(
                dark = true,
                bg = java.awt.Color(16, 17, 18),
                fg = java.awt.Color(238, 238, 238),
                inputBg = java.awt.Color(30, 31, 32),
                inputFg = java.awt.Color(240, 240, 240),
                border = java.awt.Color(60, 61, 62),
                accent = java.awt.Color(53, 116, 240),
                accentFg = java.awt.Color.WHITE,
            ),
        )
        val light = ThemeCss.css(
            ThemeColors(
                dark = false,
                bg = java.awt.Color.WHITE,
                fg = java.awt.Color(10, 10, 10),
                inputBg = java.awt.Color.WHITE,
                inputFg = java.awt.Color(10, 10, 10),
                border = java.awt.Color(200, 200, 200),
                accent = java.awt.Color(47, 111, 237),
                accentFg = java.awt.Color.WHITE,
            ),
        )
        val outbound = ConcurrentLinkedQueue<String>()
        val panel = StewartPanel({ bridge -> WebviewResources.webviewHtml(bridge, themeCss = dark) }) { outbound.add(it) }
        try {
            awaitMessage(outbound, "ready")
            panel.runScript(
                "window.stewartHost.post(JSON.stringify({type:'theme'," +
                    "bg:getComputedStyle(document.body).backgroundColor," +
                    "fg:getComputedStyle(document.body).color}));",
            )
            var probe = awaitMessage(outbound, "theme")
            assertEquals("rgb(16, 17, 18)", probe["bg"]!!.jsonPrimitive.content)
            assertEquals("rgb(238, 238, 238)", probe["fg"]!!.jsonPrimitive.content)
            panel.applyTheme(light)
            panel.runScript(
                "window.stewartHost.post(JSON.stringify({type:'theme'," +
                    "bg:getComputedStyle(document.body).backgroundColor," +
                    "fg:getComputedStyle(document.body).color}));",
            )
            probe = awaitMessage(outbound, "theme")
            assertEquals("rgb(255, 255, 255)", probe["bg"]!!.jsonPrimitive.content)
            assertEquals("rgb(10, 10, 10)", probe["fg"]!!.jsonPrimitive.content)
        } finally {
            panel.dispose()
        }
    }

    fun testWithoutEarlyBridgeTheHostHearsNothing() {
        assertTrue(JBCefApp.isSupported())
        val outbound = ConcurrentLinkedQueue<String>()
        val panel = StewartPanel({ bridge -> WebviewResources.webviewHtml("window.__late = function(){ $bridge };") }) { outbound.add(it) }
        try {
            val deadline = System.currentTimeMillis() + 3_000
            while (System.currentTimeMillis() < deadline) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(50)
            }
            assertTrue(outbound.none { it.contains("\"type\":\"ready\"") })
        } finally {
            panel.dispose()
        }
    }
}

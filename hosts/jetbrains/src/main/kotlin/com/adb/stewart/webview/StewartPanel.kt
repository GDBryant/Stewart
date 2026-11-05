package com.adb.stewart.webview

import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import kotlinx.serialization.json.JsonObject
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The JCEF webview when supported, else an actionable fallback label. Injects
 * `window.stewartHost.post(json)` into the page; inbound messages go through
 * `window.__stewartInbound(msg)`.
 */
class StewartPanel(private val indexHtml: java.io.File, private val onOutbound: (String) -> Unit) {
    val component: JPanel = JPanel(BorderLayout())
    private var browser: JBCefBrowser? = null

    init {
        if (JBCefApp.isSupported()) {
            val b = JBCefBrowser()
            browser = b
            val query = JBCefJSQuery.create(b as com.intellij.ui.jcef.JBCefBrowserBase)
            query.addHandler { msg ->
                onOutbound(msg)
                null
            }
            b.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                    if (frame.isMain) {
                        frame.executeJavaScript(
                            "window.stewartHost = { post: function(m) { ${query.inject("m")} } };",
                            frame.url,
                            0,
                        )
                    }
                }
            }, b.cefBrowser)
            b.loadURL(indexHtml.toURI().toURL().toString())
            component.add(b.component, BorderLayout.CENTER)
        } else {
            component.add(
                JLabel(
                    "<html><center>Stewart requires JCEF, which is not available in this IDE.<br>" +
                        "Use an IDE build with a bundled JBR that includes JCEF.</center></html>",
                    SwingConstants.CENTER,
                ),
                BorderLayout.CENTER,
            )
        }
    }

    fun pushInbound(msg: JsonObject) {
        browser?.cefBrowser?.executeJavaScript(
            "window.__stewartInbound && window.__stewartInbound(${msg});",
            browser?.cefBrowser?.url,
            0,
        )
    }

    fun dispose() {
        browser?.dispose()
        browser = null
    }
}

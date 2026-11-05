package com.adb.stewart.webview

import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import kotlinx.serialization.json.JsonObject
import org.cef.CefSettings
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefLoadHandler
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
class StewartPanel(private val html: (String) -> String, private val onOutbound: (String) -> Unit) {
    val component: JPanel = JPanel(BorderLayout())
    private var browser: JBCefBrowser? = null
    private val log = com.intellij.openapi.diagnostic.Logger.getInstance(StewartPanel::class.java)

    init {
        if (JBCefApp.isSupported()) {
            val b = JBCefBrowser()
            browser = b
            val query = JBCefJSQuery.create(b as com.intellij.ui.jcef.JBCefBrowserBase)
            query.addHandler { msg ->
                onOutbound(msg)
                null
            }
            b.jbCefClient.addDisplayHandler(object : CefDisplayHandlerAdapter() {
                override fun onConsoleMessage(
                    browser: CefBrowser?,
                    level: CefSettings.LogSeverity?,
                    message: String?,
                    source: String?,
                    line: Int,
                ): Boolean {
                    if (level == CefSettings.LogSeverity.LOGSEVERITY_ERROR || level == CefSettings.LogSeverity.LOGSEVERITY_FATAL) {
                        log.warn("webview console: $message ($source:$line)")
                    }
                    return false
                }
            }, b.cefBrowser)
            b.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
                override fun onLoadError(
                    browser: CefBrowser?,
                    frame: CefFrame?,
                    errorCode: CefLoadHandler.ErrorCode?,
                    errorText: String?,
                    failedUrl: String?,
                ) {
                    log.warn("webview load error: $errorCode $errorText $failedUrl")
                }
            }, b.cefBrowser)
            b.createImmediately()
            b.loadHTML(html(WebviewResources.bridgeJs(query.inject("m"))))
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

    fun applyTheme(css: String) = runScript(ThemeCss.applyJs(css))

    internal fun runScript(js: String) {
        browser?.cefBrowser?.executeJavaScript(js, browser?.cefBrowser?.url, 0)
    }

    fun dispose() {
        browser?.dispose()
        browser = null
    }
}

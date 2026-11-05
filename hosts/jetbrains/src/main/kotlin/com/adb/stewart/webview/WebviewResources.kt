package com.adb.stewart.webview

import com.adb.stewart.sidecar.NodeLocator
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * Extracts the bundled webview (webview.js/webview.css) and sidecar bundle
 * (sidecar.cjs) from plugin resources to a stable on-disk location, and builds
 * index.html with the CSP meta tag JCEF cannot set via headers on file:// URLs.
 */
object WebviewResources {
    fun csp(nonce: String): String =
        "default-src 'none'; script-src 'nonce-$nonce'; style-src 'unsafe-inline'; img-src data:"

    fun newNonce(): String {
        val bytes = ByteArray(16)
        java.security.SecureRandom().nextBytes(bytes)
        return java.util.Base64.getEncoder().encodeToString(bytes)
    }

    fun bridgeJs(injectedSend: String): String =
        "window.stewartHost = (function () { var q = []; var timer = null;" +
            " function flush() { timer = null; while (q.length) { var m = q[0];" +
            " try { $injectedSend } catch (e) { timer = setTimeout(flush, 50); return; } q.shift(); } }" +
            " return { post: function (m) { q.push(m); if (!timer) flush(); } }; })();"

    fun inlineHtml(js: String, css: String, bridgeJs: String, nonce: String): String {
        val safeJs = js.replace("</script", "<\\/script", ignoreCase = true)
        val safeBridge = bridgeJs.replace("</script", "<\\/script", ignoreCase = true)
        val safeCss = css.replace("</style", "<\\/style", ignoreCase = true)
        return "<!doctype html><html><head><meta charset=\"utf-8\">" +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"${csp(nonce)}\">" +
            "<style>$safeCss</style></head><body><div id=\"app\"></div>" +
            "<script nonce=\"$nonce\">$safeBridge</script>" +
            "<script nonce=\"$nonce\">$safeJs</script></body></html>"
    }

    fun webviewHtml(
        bridgeJs: String,
        loader: (String) -> InputStream? = { WebviewResources::class.java.getResourceAsStream(it) },
        nonce: String = newNonce(),
    ): String = inlineHtml(
        readResource(loader, "/webview/webview.js"),
        readResource(loader, "/webview/webview.css"),
        bridgeJs,
        nonce,
    )

    private fun readResource(loader: (String) -> InputStream?, name: String): String =
        (loader(name) ?: throw IOException("missing plugin resource: $name")).use { it.readBytes().toString(Charsets.UTF_8) }

    fun extractSidecar(
        dir: File,
        loader: (String) -> InputStream? = { WebviewResources::class.java.getResourceAsStream(it) },
    ): File {
        dir.mkdirs()
        val out = File(dir, "sidecar.cjs")
        copyResource(loader, "/sidecar/sidecar.cjs", out)
        extractNode(dir, loader)
        return out
    }

    private fun extractNode(dir: File, loader: (String) -> InputStream?) {
        val key = NodeLocator.osKey(System.getProperty("os.name"), System.getProperty("os.arch")) ?: return
        val exe = if (key.startsWith("windows")) "node.exe" else "node"
        val stream = loader("/node/$key/$exe") ?: return
        val out = File(File(dir, "node"), "$key/$exe")
        out.parentFile?.mkdirs()
        stream.use { input -> out.outputStream().use { input.copyTo(it) } }
        out.setExecutable(true)
    }

    private fun copyResource(loader: (String) -> InputStream?, name: String, target: File) {
        val stream = loader(name) ?: throw IOException("missing plugin resource: $name")
        stream.use { input -> target.outputStream().use { input.copyTo(it) } }
    }
}

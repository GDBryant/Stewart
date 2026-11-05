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
    const val CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"

    fun indexHtml(csp: String = CSP): String = """<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="$csp">
<link rel="stylesheet" href="webview.css"></head>
<body><div id="app"></div><script src="webview.js"></script></body></html>"""

    fun extractWebview(
        dir: File,
        loader: (String) -> InputStream? = { WebviewResources::class.java.getResourceAsStream(it) },
    ): File {
        dir.mkdirs()
        copyResource(loader, "/webview/webview.js", File(dir, "webview.js"))
        copyResource(loader, "/webview/webview.css", File(dir, "webview.css"))
        File(dir, "index.html").writeText(indexHtml(), Charsets.UTF_8)
        return File(dir, "index.html")
    }

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

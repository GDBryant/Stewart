package com.adb.stewart

import com.adb.stewart.webview.WebviewResources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files

class WebviewResourcesTest {
    private fun loader(vararg names: String): (String) -> java.io.InputStream? = { name ->
        if (name in names) ByteArrayInputStream("content:$name".toByteArray()) else null
    }

    @Test
    fun `inline html runs bridge before webview under a nonce csp`() {
        val html = WebviewResources.webviewHtml(
            "window.stewartHost={};",
            loader("/webview/webview.js", "/webview/webview.css"),
            "N0nce",
        )
        assertTrue(html.contains("script-src 'nonce-N0nce'"))
        assertTrue(html.contains("default-src 'none'"))
        assertTrue(!html.contains("'self'"))
        assertTrue(html.contains("<style>content:/webview/webview.css</style>"))
        val bridge = html.indexOf("<script nonce=\"N0nce\">window.stewartHost={};</script>")
        val app = html.indexOf("<script nonce=\"N0nce\">content:/webview/webview.js</script>")
        assertTrue(bridge >= 0 && app > bridge)
        assertTrue(!html.contains("src=\""))
    }

    @Test
    fun `inline html escapes closing tags inside js and css`() {
        val html = WebviewResources.inlineHtml("a='</script>';", "x{content:'</STYLE>'}", "b='</Script>';", "n")
        assertEquals(2, Regex("</script>").findAll(html).count())
        assertEquals(1, Regex("</style>").findAll(html).count())
        assertTrue(html.contains("a='<\\/script>';"))
        assertTrue(html.contains("<\\/style>"))
    }

    @Test
    fun `bridge wraps the injected send in a retrying queue`() {
        val js = WebviewResources.bridgeJs("SEND(m);")
        assertTrue(js.startsWith("window.stewartHost = "))
        assertTrue(js.contains("try { SEND(m); } catch (e) { timer = setTimeout(flush, 50); return; } q.shift();"))
        assertTrue(js.contains("post: function (m) { q.push(m);"))
    }

    @Test
    fun `nonces are random and base64`() {
        val a = WebviewResources.newNonce()
        assertTrue(a != WebviewResources.newNonce())
        assertTrue(Regex("^[A-Za-z0-9+/=]{24}$").matches(a))
    }

    @Test
    fun `missing resource throws`() {
        try {
            WebviewResources.webviewHtml("", loader("/webview/webview.css"), "n")
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("webview.js"))
        }
        try {
            WebviewResources.webviewHtml("", loader("/webview/webview.js"), "n")
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("webview.css"))
        }
    }

    @Test
    fun `extract sidecar bundle`() {
        val dir = Files.createTempDirectory("stewart-sc").toFile()
        val f = WebviewResources.extractSidecar(dir, loader("/sidecar/sidecar.cjs"))
        assertEquals("sidecar.cjs", f.name)
        assertTrue(f.readText().contains("sidecar.cjs"))
    }

    @Test
    fun `extract sidecar also extracts the bundled node for the host platform`() {
        val key = com.adb.stewart.sidecar.NodeLocator.osKey(
            System.getProperty("os.name"),
            System.getProperty("os.arch"),
        )!!
        val exe = if (key.startsWith("windows")) "node.exe" else "node"
        val dir = Files.createTempDirectory("stewart-sc-node").toFile()
        WebviewResources.extractSidecar(dir, loader("/sidecar/sidecar.cjs", "/node/$key/$exe"))
        val node = File(dir, "node/$key/$exe")
        assertTrue(node.isFile)
        assertTrue(node.readText().contains("node"))
    }

    @Test
    fun `extract sidecar without node resource skips bundled node`() {
        val dir = Files.createTempDirectory("stewart-sc-nonode").toFile()
        WebviewResources.extractSidecar(dir, loader("/sidecar/sidecar.cjs"))
        assertTrue(!File(dir, "node").exists())
    }
}

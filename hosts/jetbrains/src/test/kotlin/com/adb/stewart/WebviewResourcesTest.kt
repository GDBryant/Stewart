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
    fun `index html carries csp and bundle refs`() {
        val html = WebviewResources.indexHtml()
        assertTrue(html.contains("Content-Security-Policy"))
        assertTrue(html.contains("default-src 'none'"))
        assertTrue(html.contains("webview.js"))
        assertTrue(html.contains("webview.css"))
    }

    @Test
    fun `extract writes js css and index`() {
        val dir = Files.createTempDirectory("stewart-wv").toFile()
        val index = WebviewResources.extractWebview(dir, loader("/webview/webview.js", "/webview/webview.css"))
        assertTrue(index.isFile)
        assertTrue(File(dir, "webview.js").readText().contains("webview.js"))
        assertTrue(index.readText().contains("webview.css"))
    }

    @Test
    fun `missing resource throws`() {
        val dir = Files.createTempDirectory("stewart-wv-miss").toFile()
        try {
            WebviewResources.extractWebview(dir, loader())
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("webview.js"))
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

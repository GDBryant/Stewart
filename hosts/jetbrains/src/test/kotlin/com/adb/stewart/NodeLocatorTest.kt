package com.adb.stewart

import com.adb.stewart.sidecar.NodeLocator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files

class NodeLocatorTest {
    @Test
    fun `osKey maps platforms`() {
        assertEquals("linux-x64", NodeLocator.osKey("Linux", "amd64"))
        assertEquals("linux-arm64", NodeLocator.osKey("Linux", "aarch64"))
        assertEquals("macos-arm64", NodeLocator.osKey("Mac OS X", "aarch64"))
        assertEquals("windows-x64", NodeLocator.osKey("Windows 11", "amd64"))
        assertEquals("macos-arm64", NodeLocator.osKey("Darwin", "arm64"))
        assertEquals("linux-x64", NodeLocator.osKey("Linux", "x86_64"))
        assertNull(NodeLocator.osKey("FreeBSD", "amd64"))
        assertNull(NodeLocator.osKey("Linux", "riscv64"))
    }

    @Test
    fun `bundledNode finds extracted binary`() {
        val dir = Files.createTempDirectory("stewart-node").toFile()
        val f = File(dir, "node/linux-x64/node")
        f.parentFile.mkdirs()
        f.createNewFile()
        assertEquals(f, NodeLocator.bundledNode(dir, "Linux", "amd64"))
        assertNull(NodeLocator.bundledNode(dir, "Mac OS X", "aarch64"))
    }

    @Test
    fun `onPath finds executable and skips non-exec`() {
        val dir = Files.createTempDirectory("stewart-path").toFile()
        val bin = File(dir, "bin").also { it.mkdirs() }
        val node = File(bin, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        node.createNewFile()
        node.setExecutable(true)
        assertEquals(node, NodeLocator.onPath(bin.absolutePath))
        node.setExecutable(false)
        assertNull(NodeLocator.onPath(bin.absolutePath))
        assertNull(NodeLocator.onPath(""))
    }

    @Test
    fun `bundledNode uses exe on windows`() {
        val dir = Files.createTempDirectory("stewart-node-win").toFile()
        val f = File(dir, "node/windows-x64/node.exe")
        f.parentFile.mkdirs()
        f.createNewFile()
        assertEquals(f, NodeLocator.bundledNode(dir, "Windows 11", "amd64"))
        assertNull(NodeLocator.bundledNode(dir, "Windows 11", "aarch64"))
    }

    @Test
    fun `onPath skips blank segments`() {
        val dir = Files.createTempDirectory("stewart-path2").toFile()
        val node = File(dir, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        node.createNewFile()
        node.setExecutable(true)
        val path = "${File.pathSeparator}${File.pathSeparator}${dir.absolutePath}${File.pathSeparator}"
        assertEquals(node, NodeLocator.onPath(path))
    }

    @Test
    fun `onPath null returns null`() {
        assertNull(NodeLocator.onPath(null))
    }

    @Test
    fun `resolve without bundled root falls back to path`() {
        assertEquals(NodeLocator.onPath(""), NodeLocator.resolve(null, ""))
    }

    @Test
    fun `resolve prefers bundled then PATH`() {
        val dir = Files.createTempDirectory("stewart-resolve").toFile()
        val f = File(dir, "node/linux-x64/node")
        f.parentFile.mkdirs()
        f.createNewFile()
        val bundled = NodeLocator.bundledNode(dir)
        assertEquals(bundled ?: NodeLocator.onPath(""), NodeLocator.resolve(dir, ""))
    }
}

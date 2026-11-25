package com.adb.stewart

import com.adb.stewart.sidecar.NodeLocator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

class NodeLocatorTest {
    private fun tmp(prefix: String): Path = Files.createTempDirectory("stewart-$prefix")

    private fun stubNode(dir: Path, versionLine: String): File {
        val node = if (System.getProperty("os.name").startsWith("Windows")) File(dir.toFile(), "node.exe") else File(dir.toFile(), "node")
        node.writeText("#!/bin/sh\necho \"$versionLine\"\n")
        node.setExecutable(true)
        return node
    }

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
        val dir = tmp("node").toFile()
        val f = File(dir, "node/linux-x64/node")
        f.parentFile.mkdirs()
        f.createNewFile()
        assertEquals(f, NodeLocator.bundledNode(dir, "Linux", "amd64"))
        assertNull(NodeLocator.bundledNode(dir, "Mac OS X", "aarch64"))
    }

    @Test
    fun `onPath finds node 22 and skips non-exec`() {
        val bin = tmp("path").resolve("bin").also { Files.createDirectories(it) }
        val node = File(bin.toFile(), if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        node.createNewFile()
        node.setExecutable(true)
        assertEquals(node, NodeLocator.onPath(bin.toString(), probe = { 22 }))
        node.setExecutable(false)
        assertNull(NodeLocator.onPath(bin.toString(), probe = { 22 }))
        assertNull(NodeLocator.onPath(""))
    }

    @Test
    fun `onPath skips blank segments`() {
        val dir = tmp("path2").toFile()
        val node = File(dir, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        node.createNewFile()
        node.setExecutable(true)
        val path = "${File.pathSeparator}${File.pathSeparator}${dir.absolutePath}${File.pathSeparator}"
        assertEquals(node, NodeLocator.onPath(path, probe = { 22 }))
    }

    @Test
    fun `onPath null returns null`() {
        assertNull(NodeLocator.onPath(null))
    }

    @Test
    fun `onPath rejects old node major via probe`() {
        val dir = tmp("old").toFile()
        val node = File(dir, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        node.createNewFile()
        node.setExecutable(true)
        assertNull(NodeLocator.onPath(dir.absolutePath, probe = { 18 }))
        assertNull(NodeLocator.onPath(dir.absolutePath, probe = { null }))
    }

    @Test
    fun `onPath keeps searching past a failing probe`() {
        val old = tmp("old2").toFile()
        val oldNode = File(old, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        oldNode.createNewFile()
        oldNode.setExecutable(true)
        val good = tmp("good2").toFile()
        val goodNode = File(good, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        goodNode.createNewFile()
        goodNode.setExecutable(true)
        val path = "${old.absolutePath}${File.pathSeparator}${good.absolutePath}"
        assertEquals(goodNode, NodeLocator.onPath(path, probe = { f -> if (f == oldNode) 14 else 22 }))
    }

    @Test
    fun `probeMajor parses version of a stub executable`() {
        assumeFalse(System.getProperty("os.name").startsWith("Windows"))
        val dir = tmp("probe")
        val v22 = stubNode(dir, "v22.20.0")
        assertEquals(22, NodeLocator.probeMajor(v22))
        val v18 = stubNode(dir, "v18.19.0")
        assertEquals(18, NodeLocator.probeMajor(v18))
        val junk = stubNode(dir, "not a version")
        assertNull(NodeLocator.probeMajor(junk))
    }

    @Test
    fun `probeMajor times out and destroys the child`() {
        assumeFalse(System.getProperty("os.name").startsWith("Windows"))
        val dir = tmp("hang")
        val hang = File(dir.toFile(), "node")
        hang.writeText("#!/bin/sh\nsleep 30\n")
        hang.setExecutable(true)
        assertNull(NodeLocator.probeMajor(hang, 500))
        val missing = File(dir.toFile(), "no-such-node")
        assertNull(NodeLocator.probeMajor(missing, 500))
    }

    @Test
    fun `onPath with real probe accepts a node 22 stub`() {
        assumeFalse(System.getProperty("os.name").startsWith("Windows"))
        val dir = tmp("real22")
        val node = stubNode(dir, "v22.20.0")
        assertEquals(node, NodeLocator.onPath(dir.toString(), probe = NodeLocator::probeMajor))
        val oldDir = tmp("real18")
        stubNode(oldDir, "v18.19.0")
        assertNull(NodeLocator.onPath(oldDir.toString(), probe = NodeLocator::probeMajor))
    }

    @Test
    fun `resolve without bundled root falls back to path`() {
        assertEquals(NodeLocator.onPath(""), NodeLocator.resolve(null, ""))
    }

    @Test
    fun `resolve prefers bundled then PATH`() {
        val dir = tmp("resolve").toFile()
        val f = File(dir, "node/linux-x64/node")
        f.parentFile.mkdirs()
        f.createNewFile()
        val bundled = NodeLocator.bundledNode(dir)
        assertEquals(bundled ?: NodeLocator.onPath(""), NodeLocator.resolve(dir, ""))
    }

    @Test
    fun `resolve applies the probe to the PATH fallback`() {
        val dir = tmp("resolve2").toFile()
        val node = File(dir, if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node")
        node.createNewFile()
        node.setExecutable(true)
        assertEquals(node, NodeLocator.resolve(null, dir.absolutePath, probe = { 22 }))
        assertNull(NodeLocator.resolve(null, dir.absolutePath, probe = { 21 }))
    }
}

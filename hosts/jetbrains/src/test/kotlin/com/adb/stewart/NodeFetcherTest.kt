package com.adb.stewart

import com.adb.stewart.sidecar.NodeFetcher
import com.adb.stewart.sidecar.NodeLocator
import com.adb.stewart.sidecar.NodeTarget
import com.sun.net.httpserver.HttpServer
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class NodeFetcherTest {
    private fun tmp(prefix: String): Path = Files.createTempDirectory("stewart-$prefix")

    private fun nodeExeName(): String =
        if (System.getProperty("os.name").startsWith("Windows")) "node.exe" else "node"

    /** Host platform key (tests run on the dev machine, not emulated platforms). */
    private fun key(): String =
        NodeLocator.osKey(System.getProperty("os.name"), System.getProperty("os.arch")) ?: "linux-x64"

    /** <dir>/node/<key>/node(.exe) marked as a file. */
    private fun fakeBundled(root: File, k: String): File {
        val f = File(File(root, "node"), "$k/${nodeExeName()}")
        f.parentFile.mkdirs()
        f.writeText("fake")
        return f
    }

    /** <cache>/<key>/node(.exe) marked as a file. */
    private fun fakeCached(cache: File, k: String): File {
        val f = File(File(cache, k), nodeExeName())
        f.parentFile.mkdirs()
        f.writeText("cached")
        return f
    }

    private fun onPathNode(dir: Path): File {
        val node = File(dir.toFile(), nodeExeName())
        node.writeText("path-node")
        node.setExecutable(true)
        return node
    }

    private fun sha256(b: ByteArray): String = NodeFetcher.sha256Hex(b)

    private fun expectedTarget(osName: String, osArch: String): NodeTarget =
        checkNotNull(NodeFetcher.target(osName, osArch)) { "no target for $osName/$osArch" }

    /** Real nodejs.org-style SHASUMS256.txt body for [archive]/[bytes]. */
    private fun shasums(archive: String, bytes: ByteArray): String =
        "${sha256(bytes)}  $archive\n"

    private fun fakeFetcher(map: Map<String, ByteArray>, calls: MutableList<String>): (String, (Long, Long) -> Unit, () -> Boolean) -> ByteArray = { url, _, _ ->
        calls.add(url)
        map[url] ?: error("unexpected fetch: $url")
    }

    private fun nodeContent() = "fake-node-binary".toByteArray()

    /** Real gzipped tar. [relative] may be relative to [rootDir] or an already-qualified path; parent dirs included. */
    private fun tarGz(rootDir: String, relative: String = "bin/node"): ByteArray {
        val raw = ByteArrayOutputStream()
        GZIPOutputStream(raw).use { gz ->
            TarArchiveOutputStream(gz).use { tar ->
                tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
                val entry = if (relative.startsWith("$rootDir/")) relative else "$rootDir/$relative"
                val dirs = mutableSetOf(rootDir)
                var parent = rootDir.substringBeforeLast('/')
                while (parent.isNotEmpty() && parent.contains('/')) {
                    dirs.add(parent)
                    parent = parent.substringBeforeLast('/')
                }
                var p = entry.substringBeforeLast('/')
                while (p.isNotEmpty() && p.contains('/')) {
                    dirs.add(p)
                    p = p.substringBeforeLast('/')
                }
                dirs.sorted().forEach { d ->
                    tar.putArchiveEntry(TarArchiveEntry("$d/"))
                    tar.closeArchiveEntry()
                }
                val e = TarArchiveEntry(entry)
                e.setSize(nodeContent().size.toLong())
                tar.putArchiveEntry(e)
                tar.write(nodeContent())
                tar.closeArchiveEntry()
            }
        }
        return raw.toByteArray()
    }

    private fun zipArchive(member: String): ByteArray {
        val raw = ByteArrayOutputStream()
        ZipOutputStream(raw).use { zip ->
            zip.putNextEntry(ZipEntry(member))
            zip.write(nodeContent())
            zip.closeEntry()
        }
        return raw.toByteArray()
    }

    private fun contentEquals(expected: ByteArray, actual: ByteArray) {
        if (expected.size != actual.size) fail("size ${actual.size} != ${expected.size}")
        for (i in expected.indices) if (expected[i] != actual[i]) fail("byte $i differs")
    }

    @Test
    fun `target maps supported platforms`() {
        assertEquals("node-v${NodeFetcher.VERSION}-linux-x64.tar.gz", expectedTarget("Linux", "amd64").archive)
        assertEquals("node-v${NodeFetcher.VERSION}-linux-arm64.tar.gz", expectedTarget("Linux", "aarch64").archive)
        assertEquals("node-v${NodeFetcher.VERSION}-darwin-x64.tar.gz", expectedTarget("Mac OS X", "x86_64").archive)
        assertEquals("node-v${NodeFetcher.VERSION}-darwin-arm64.tar.gz", expectedTarget("Darwin", "arm64").archive)
        assertEquals("node-v${NodeFetcher.VERSION}-win-x64.zip", expectedTarget("Windows 11", "amd64").archive)
        assertEquals("node.exe", expectedTarget("Windows 11", "amd64").exe)
        assertNull(NodeFetcher.target("FreeBSD", "amd64"))
        assertNull(NodeFetcher.target("Linux", "riscv64"))
    }

    @Test
    fun `cached finds or misses by platform key`() {
        val cache = tmp("cache").toFile()
        val f = fakeCached(cache, "linux-x64")
        assertEquals(f, NodeFetcher.cached(cache, "linux-x64"))
        assertNull(NodeFetcher.cached(cache, "macos-arm64"))
    }

    @Test
    fun `sha256Hex matches a known vector`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256(ByteArray(0)))
        assertEquals(sha256(nodeContent()), NodeFetcher.sha256Hex(ByteArrayInputStream(nodeContent())))
    }

    @Test
    fun `shasumFor parses plain and binary entries and rejects junk`() {
        val win = "node-v${NodeFetcher.VERSION}-win-x64.zip"
        val linux = "node-v${NodeFetcher.VERSION}-linux-x64.tar.gz"
        val plain = String.format("%064d", 1)
        val binary = "0".repeat(63) + "f"
        val text = """
            ${plain} somefile
            ${binary} *$win
            not-a-hash  $linux
            short  node.tar.gz
        """.trimIndent()
        assertEquals(String.format("%064d", 1), NodeFetcher.shasumFor(text, "somefile"))
        assertEquals(binary, NodeFetcher.shasumFor(text, win))
        assertNull(NodeFetcher.shasumFor(text, linux))
        assertNull(NodeFetcher.shasumFor(text, "missing.tar.gz"))
        assertNull(NodeFetcher.shasumFor("${"0".repeat(63)}ff  $linux", linux))
    }

    @Test
    fun `fetch installs tar gz member into cache`() {
        val t = expectedTarget("Linux", "amd64")
        val archive = tarGz("node-v${NodeFetcher.VERSION}-linux-x64", "node-v${NodeFetcher.VERSION}-linux-x64/bin/node")
        val cache = tmp("fetch-tar").toFile()
        val calls = CopyOnWriteArrayList<String>()
        val node = NodeFetcher.fetch(t, cache, base = "http://base", fetchBytes = fakeFetcher(mapOf(
            "http://base/SHASUMS256.txt" to shasums(t.archive, archive).toByteArray(),
            "http://base/${t.archive}" to archive,
        ), calls))
        assertEquals(File(cache, "linux-x64/node"), node)
        assertTrue(node.isFile)
        contentEquals(nodeContent(), node.readBytes())
        assertEquals(listOf("http://base/SHASUMS256.txt", "http://base/${t.archive}"), calls)
    }

    @Test
    fun `fetch installs zip member on windows target`() {
        val t = expectedTarget("Windows 11", "amd64")
        val archive = zipArchive("node-v${NodeFetcher.VERSION}-win-x64/node.exe")
        val cache = tmp("fetch-zip").toFile()
        val node = NodeFetcher.fetch(t, cache, base = "http://base", fetchBytes = fakeFetcher(mapOf(
            "http://base/SHASUMS256.txt" to shasums(t.archive, archive).toByteArray(),
            "http://base/${t.archive}" to archive,
        ), CopyOnWriteArrayList()))
        assertEquals(File(cache, "windows-x64/node.exe"), node)
        contentEquals(nodeContent(), node.readBytes())
    }

    @Test
    fun `fetch reports archive byte progress`() {
        val t = expectedTarget("Linux", "amd64")
        val archive = tarGz("node-v${NodeFetcher.VERSION}-linux-x64", "node-v${NodeFetcher.VERSION}-linux-x64/bin/node")
        val cache = tmp("fetch-prog").toFile()
        val events = CopyOnWriteArrayList<Pair<Long, Long>>()
        NodeFetcher.fetch(t, cache, onProgress = { done, total -> events.add(done to total) }, base = "http://base", fetchBytes = { url, p, _ ->
            if (url.endsWith("SHASUMS256.txt")) shasums(t.archive, archive).toByteArray()
            else {
                p(archive.size.toLong(), archive.size.toLong())
                archive
            }
        })
        assertTrue(events.contains(archive.size.toLong() to archive.size.toLong()))
    }

    @Test
    fun `fetch short circuits on cached binary without network`() {
        val t = expectedTarget("Linux", "amd64")
        val cache = tmp("fetch-hit").toFile()
        val existing = fakeCached(cache, "linux-x64")
        val calls = CopyOnWriteArrayList<String>()
        assertEquals(existing, NodeFetcher.fetch(t, cache, base = "http://base", fetchBytes = fakeFetcher(emptyMap(), calls)))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `fetch rejects a checksum mismatch`() {
        val t = expectedTarget("Linux", "amd64")
        val archive = tarGz("node-v${NodeFetcher.VERSION}-linux-x64")
        val cache = tmp("fetch-bad").toFile()
        val body = "a".repeat(64) + "  ${t.archive}\n"
        try {
            NodeFetcher.fetch(t, cache, base = "http://base", fetchBytes = fakeFetcher(mapOf(
                "http://base/SHASUMS256.txt" to body.toByteArray(),
                "http://base/${t.archive}" to archive,
            ), CopyOnWriteArrayList()))
            fail("expected sha256 mismatch")
        } catch (e: NodeFetcher.NodeFetchException) {
            assertTrue(e.message!!.contains("sha256 mismatch"))
        }
        assertNull(NodeFetcher.cached(cache, "linux-x64"))
    }

    @Test
    fun `fetch rejects a missing shasums entry`() {
        val t = expectedTarget("Linux", "amd64")
        try {
            NodeFetcher.fetch(t, tmp("fetch-nosh").toFile(), base = "http://base", fetchBytes = { url, _, _ ->
                if (url.endsWith("SHASUMS256.txt")) "unrelated  node.tar.gz\n".toByteArray() else ByteArray(1)
            })
            fail("expected missing shasums entry")
        } catch (e: NodeFetcher.NodeFetchException) {
            assertTrue(e.message!!.contains("no SHASUMS256 entry"))
        }
    }

    @Test
    fun `fetch rejects an archive without the node member`() {
        val t = expectedTarget("Linux", "amd64")
        // archive has node-v…-linux-x64/bin/node but the target asks for another member -> extraction finds nothing
        val archive = tarGz("node-v${NodeFetcher.VERSION}-linux-x64")
        val t2 = NodeTarget("linux-x64", "node-v${NodeFetcher.VERSION}-linux-x64.tar.gz", "node-v${NodeFetcher.VERSION}-linux-x64/bin/absent", "node")
        val cache = tmp("fetch-nomember").toFile()
        try {
            NodeFetcher.fetch(t2, cache, base = "http://base", fetchBytes = fakeFetcher(mapOf(
                "http://base/SHASUMS256.txt" to shasums(t2.archive, archive).toByteArray(),
                "http://base/${t2.archive}" to archive,
            ), CopyOnWriteArrayList()))
            fail("expected missing member")
        } catch (e: NodeFetcher.NodeFetchException) {
            assertTrue(e.message!!.contains("did not contain"))
        }
    }

    @Test
    fun `downloadBytes fetches and reports progress`() {
        val body = "hello stewart".toByteArray()
        val server = HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        try {
            server.createContext("/f") { ex ->
                ex.responseHeaders.add("Content-Length", body.size.toString())
                ex.sendResponseHeaders(200, body.size.toLong())
                ex.responseBody.use { it.write(body) }
            }
            server.start()
            val base = "http://127.0.0.1:${server.address.port}"
            val events = CopyOnWriteArrayList<Pair<Long, Long>>()
            val got = NodeFetcher.downloadBytes("$base/f", onProgress = { d, t -> events.add(d to t) })
            contentEquals(body, got)
            assertTrue(events.contains(body.size.toLong() to body.size.toLong()))
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `downloadBytes throws on http error`() {
        val server = HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        try {
            server.createContext("/f") { ex -> ex.sendResponseHeaders(404, -1) }
            server.start()
            try {
                NodeFetcher.downloadBytes("http://127.0.0.1:${server.address.port}/f")
                fail("expected HTTP error")
            } catch (e: NodeFetcher.NodeFetchException) {
                assertTrue(e.message!!.contains("HTTP 404"))
            }
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `resolveNode prefers bundled over cache and path`() {
        val root = tmp("rn-bundled").toFile()
        val cache = tmp("rn-bundled-cache").toFile()
        val pathDir = tmp("rn-bundled-path")
        val bundled = fakeBundled(root, key())
        fakeCached(cache, key())
        onPathNode(pathDir)
        val (node, downloaded) = NodeFetcher.resolveNode(root, cache, pathEnv = pathDir.toString(), probe = { 22 })
        assertEquals(bundled, node)
        assertFalse(downloaded)
    }

    @Test
    fun `resolveNode uses cache before path`() {
        val cache = tmp("rn-cache").toFile()
        val pathDir = tmp("rn-cache-path")
        val cached = fakeCached(cache, key())
        onPathNode(pathDir)
        val (node, downloaded) = NodeFetcher.resolveNode(null, cache, pathEnv = pathDir.toString(), probe = { 22 })
        assertEquals(cached, node)
        assertFalse(downloaded)
    }

    @Test
    fun `resolveNode uses path node 22 before download`() {
        val cache = tmp("rn-path").toFile()
        val pathDir = tmp("rn-path-node")
        val onPath = onPathNode(pathDir)
        val (node, downloaded) = NodeFetcher.resolveNode(null, cache, pathEnv = pathDir.toString(), probe = { 22 })
        assertEquals(onPath, node)
        assertFalse(downloaded)
    }

    @Test
    fun `resolveNode rejects an old path node and downloads`() {
        val cache = tmp("rn-old").toFile()
        val pathDir = tmp("rn-old-node")
        onPathNode(pathDir)
        var fetched = false
        val k = key()
        val out = File(File(cache, k), nodeExeName())
        val (node, downloaded) = NodeFetcher.resolveNode(
            null, cache, pathEnv = pathDir.toString(), probe = { 18 },
            fetch = { t, c, _, _ -> fetched = true; fakeCached(c, t.osKey) },
        )
        assertTrue(fetched)
        assertTrue(downloaded)
        assertEquals(out, node)
    }

    @Test
    fun `resolveNode reports download progress through fetch`() {
        val cache = tmp("rn-prog").toFile()
        val k = key()
        val out = File(File(cache, k), nodeExeName())
        val msgs = CopyOnWriteArrayList<String>()
        val (node, downloaded) = NodeFetcher.resolveNode(
            null, cache, onProgress = { msgs.add(it) }, pathEnv = "",
            fetch = { t, c, p, _ -> p(1024L, 2048L); fakeCached(c, t.osKey) },
        )
        assertTrue(downloaded)
        assertEquals(out, node)
        assertTrue(msgs.first().startsWith("Downloading Node ${NodeFetcher.VERSION}"))
        assertTrue(msgs.any { it.contains("0 MB of") })
    }

    @Test
    fun `resolveNode aborts a cancelled download`() {
        val cache = tmp("rn-cancelled").toFile()
        try {
            NodeFetcher.resolveNode(null, cache, pathEnv = "", canceled = { true },
                fetch = { t, c, _, _ -> NodeFetcher.fetch(t, c, canceled = { true }) })
            fail("expected cancel")
        } catch (e: NodeFetcher.NodeFetchException) {
            assertTrue(e.message!!.contains("download cancelled"))
        }
        assertNull(NodeFetcher.cached(cache, key()))
    }

    @Test
    fun `downloadBytes honors cancellation between chunks`() {
        val body = "hello stewart".toByteArray()
        val server = HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        try {
            server.createContext("/f") { ex ->
                ex.responseHeaders.add("Content-Length", body.size.toString())
                ex.sendResponseHeaders(200, body.size.toLong())
                ex.responseBody.use { it.write(body) }
            }
            server.start()
            try {
                NodeFetcher.downloadBytes("http://127.0.0.1:${server.address.port}/f", onProgress = { _, _ -> }, canceled = { true })
                fail("expected cancel")
            } catch (e: NodeFetcher.NodeFetchException) {
                assertTrue(e.message!!.contains("download cancelled"))
            }
        } finally {
            server.stop(0)
        }
    }
}

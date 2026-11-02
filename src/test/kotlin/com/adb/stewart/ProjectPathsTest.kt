package com.adb.stewart

import com.adb.stewart.tools.ProjectPaths
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProjectPathsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun paths(root: Path? = null): ProjectPaths {
        val r = root ?: tmp.root.toPath()
        return ProjectPaths(listOf(r), r)
    }

    @Test
    fun `relative path resolves under base`() {
        tmp.newFile("a.txt")
        val p = paths().resolve("a.txt")
        assertEquals(tmp.root.toPath().toRealPath().resolve("a.txt"), p)
    }

    @Test
    fun `absolute path inside resolves`() {
        val f = tmp.newFile("b.txt")
        assertEquals(f.toPath().toRealPath(), paths().resolve(f.absolutePath))
    }

    @Test
    fun `dotdot escape rejected`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            paths().resolve("../outside.txt")
        }
        assertTrue(e.message!!.contains("outside project"))
    }

    @Test
    fun `absolute outside rejected`() {
        val outside = Files.createTempDirectory("aijb-out-")
        val f = Files.write(outside.resolve("x.txt"), "x".toByteArray())
        assertThrows(IllegalArgumentException::class.java) {
            paths().resolve(f.toString())
        }
    }

    @Test
    fun `symlink file pointing outside rejected`() {
        val outside = Files.createTempDirectory("aijb-out-")
        val target = Files.write(outside.resolve("sec.txt"), "s".toByteArray())
        val link = tmp.root.toPath().resolve("link.txt")
        try {
            Files.createSymbolicLink(link, target)
        } catch (e: Exception) {
            return
        }
        assertThrows(IllegalArgumentException::class.java) {
            paths().resolve("link.txt")
        }
    }

    @Test
    fun `symlink dir pointing outside rejected`() {
        val outside = Files.createTempDirectory("aijb-out-")
        val link = tmp.root.toPath().resolve("linked")
        try {
            Files.createSymbolicLink(link, outside)
        } catch (e: Exception) {
            return
        }
        assertThrows(IllegalArgumentException::class.java) {
            paths().resolve("linked/file.txt")
        }
    }

    @Test
    fun `symlink inside pointing inside ok`() {
        tmp.newFolder("real")
        Files.write(tmp.root.toPath().resolve("real/in.txt"), "x".toByteArray())
        try {
            Files.createSymbolicLink(tmp.root.toPath().resolve("alias"), tmp.root.toPath().resolve("real"))
        } catch (e: Exception) {
            return
        }
        val p = paths().resolve("alias/in.txt")
        assertTrue(p.endsWith("in.txt"))
    }

    @Test
    fun `new file under new nested dirs ok`() {
        val p = paths().resolve("a/b/c/new.txt")
        assertTrue(p.startsWith(tmp.root.toPath().toRealPath()))
    }

    @Test
    fun `new file under symlinked outside dir rejected`() {
        val outside = Files.createTempDirectory("aijb-out-")
        try {
            Files.createSymbolicLink(tmp.root.toPath().resolve("linked"), outside)
        } catch (e: Exception) {
            return
        }
        assertThrows(IllegalArgumentException::class.java) {
            paths().resolve("linked/deep/new.txt")
        }
    }

    @Test
    fun `blank path rejected`() {
        assertThrows(IllegalArgumentException::class.java) { paths().resolve("  ") }
    }

    @Test
    fun `relative for display`() {
        val base = tmp.root.toPath().toRealPath()
        assertEquals("x/y.txt", paths().relative(base.resolve("x/y.txt")))
        val outside = Files.createTempDirectory("aijb-out-").toRealPath()
        assertEquals(outside.resolve("z").toString(), paths().relative(outside.resolve("z")))
    }
}

package com.adb.stewart

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class InstallScriptTest {

    private val script = File("scripts/install-plugin.sh").absoluteFile
    private lateinit var base: File
    private lateinit var ide: File

    @Before
    fun setUp() {
        assumeTrue("needs bash + unzip", File("/bin/bash").exists() && onPath("unzip"))
        base = Files.createTempDirectory("stewart-install-").toFile()
        ide = File(base, "IntelliJIdea2025.1").apply { mkdirs() }
    }

    private fun onPath(cmd: String) =
        System.getenv("PATH").orEmpty().split(File.pathSeparator).any { File(it, cmd).canExecute() }

    private fun zipWithRoot(root: String): File {
        val zip = File(base, "$root-0.2.0.zip")
        ZipOutputStream(zip.outputStream()).use { z ->
            z.putNextEntry(ZipEntry("$root/lib/$root.jar")); z.write("jar".toByteArray()); z.closeEntry()
        }
        return zip
    }

    private fun run(zip: File): Pair<Int, String> {
        val p = ProcessBuilder("bash", script.path, "--no-build", ide.name)
            .redirectErrorStream(true)
            .apply { environment()["JETBRAINS_DATA_DIR"] = base.path; environment()["PLUGIN_ZIP"] = zip.path }
            .start()
        val out = p.inputStream.bufferedReader().readText()
        assertTrue(p.waitFor(30, TimeUnit.SECONDS))
        return p.exitValue() to out
    }

    @Test
    fun `install removes a stale aijb-assistant plugin dir and reports it`() {
        File(ide, "aijb-assistant/lib").mkdirs()
        val (code, out) = run(zipWithRoot("stewart"))
        assertEquals(out, 0, code)
        assertFalse(File(ide, "aijb-assistant").exists())
        assertTrue(File(ide, "stewart/lib/stewart.jar").isFile)
        assertTrue(out, out.contains("removed stale aijb-assistant -> ${ide.path}"))
    }

    @Test
    fun `install without a stale dir reports no removal`() {
        File(ide, "other-plugin").mkdirs()
        val (code, out) = run(zipWithRoot("stewart"))
        assertEquals(out, 0, code)
        assertTrue(File(ide, "other-plugin").isDirectory)
        assertTrue(File(ide, "stewart/lib/stewart.jar").isFile)
        assertFalse(out, out.contains("removed stale"))
    }

    @Test
    fun `install of a zip still named aijb-assistant does not report it as stale`() {
        File(ide, "aijb-assistant/lib").mkdirs()
        val (code, out) = run(zipWithRoot("aijb-assistant"))
        assertEquals(out, 0, code)
        assertTrue(File(ide, "aijb-assistant/lib/aijb-assistant.jar").isFile)
        assertFalse(out, out.contains("removed stale"))
    }
}

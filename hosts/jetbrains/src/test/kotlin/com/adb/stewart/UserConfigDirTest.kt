package com.adb.stewart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UserConfigDirTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun `shared resolves override, xdg, appdata, default`() {
        assertEquals(File("/x"), UserConfigDir.shared(mapOf("STEWART_CONFIG_DIR" to "/x", "XDG_CONFIG_HOME" to "/y"), "/h", false))
        assertEquals(File("/y/stewart"), UserConfigDir.shared(mapOf("XDG_CONFIG_HOME" to "/y"), "/h", false))
        assertEquals(File("/a/stewart"), UserConfigDir.shared(mapOf("APPDATA" to "/a"), "/h", true))
        assertEquals(File("/h/.config/stewart"), UserConfigDir.shared(mapOf("APPDATA" to "/a"), "/h", false))
    }

    @Test
    fun `ensure creates missing tree with skills and is idempotent`() {
        val dir = File(tmp.root, "a/b/.config/stewart")
        UserConfigDir.ensure(dir)
        assertTrue(File(dir, "skills").isDirectory)
        File(dir, "settings.yaml").writeText("keep")
        UserConfigDir.ensure(dir)
        assertEquals("keep", File(dir, "settings.yaml").readText())
    }

    @Test
    fun `ensure migrates legacy without overwriting`() {
        val dir = File(tmp.root, "shared").apply { mkdirs() }
        File(dir, "roles.yaml").writeText("mine")
        val l1 = File(tmp.root, "l1").apply { File(this, "skills").mkdirs() }
        File(l1, "settings.yaml").writeText("l1")
        File(l1, "roles.yaml").writeText("legacy")
        File(l1, "skills/a.md").writeText("A")
        val l2 = File(tmp.root, "l2").apply { mkdirs() }
        File(l2, "settings.yaml").writeText("l2")
        File(l2, "agents.yaml").writeText("ag")
        UserConfigDir.ensure(dir, listOf(l1, l2, File(tmp.root, "missing"), dir))
        assertEquals("l1", File(dir, "settings.yaml").readText())
        assertEquals("ag", File(dir, "agents.yaml").readText())
        assertEquals("A", File(dir, "skills/a.md").readText())
        assertEquals("mine", File(dir, "roles.yaml").readText())
    }

    @Test
    fun `legacyDirs puts own project first and tolerates missing root`() {
        val root = File(tmp.root, "uc").apply { mkdirs() }
        File(root, "h1").mkdirs(); File(root, "h2").mkdirs()
        assertEquals("h2", UserConfigDir.legacyDirs(root, "h2").first().name)
        assertFalse(UserConfigDir.legacyDirs(File(tmp.root, "none"), "h").isNotEmpty())
    }
}

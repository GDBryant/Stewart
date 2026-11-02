package com.adb.stewart

import com.adb.stewart.chat.ChatHistoryStore
import com.adb.stewart.settings.LegacyMigration
import com.adb.stewart.settings.StewartSettings
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LegacyMigrationTest {

    private lateinit var dir: Path

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("stewart-migration-")
    }

    @After
    fun tearDown() {
        dir.toFile().deleteRecursively()
    }

    private fun legacySettings(body: String, component: String = LegacyMigration.SETTINGS_COMPONENT): Path =
        dir.resolve(LegacyMigration.SETTINGS_FILE).also {
            Files.writeString(it, "<application><component name=\"$component\">$body</component></application>")
        }

    // --- untouched detection ---

    @Test
    fun `fresh state is untouched`() {
        assertTrue(LegacyMigration.isUntouched(StewartSettings.State(), StewartSettings.State()))
    }

    @Test
    fun `modified state is not untouched`() {
        val s = StewartSettings.State().apply { ollamaUrl = "http://other:1" }
        assertFalse(LegacyMigration.isUntouched(s, StewartSettings.State()))
    }

    @Test
    fun `state set back to its defaults counts as untouched`() {
        val s = StewartSettings.State().apply { ollamaUrl = "http://other:1" }
        s.ollamaUrl = "http://localhost:11434"
        assertTrue(s.modificationCount > 0)
        assertTrue(LegacyMigration.isUntouched(s, StewartSettings.State()))
    }

    // --- reading the old file ---

    @Test
    fun `readState returns null for a missing file`() {
        assertNull(LegacyMigration.readState(dir.resolve("nope.xml"), "X", StewartSettings.State::class.java))
    }

    @Test
    fun `readState returns null when the component is absent`() {
        val f = legacySettings("<option name=\"ollamaUrl\" value=\"http://old:1\"/>", component = "Other")
        assertNull(LegacyMigration.readState(f, LegacyMigration.SETTINGS_COMPONENT, StewartSettings.State::class.java))
    }

    @Test
    fun `readState returns null for corrupt xml`() {
        val f = dir.resolve("bad.xml").also { Files.writeString(it, "<application><component") }
        assertNull(LegacyMigration.readState(f, LegacyMigration.SETTINGS_COMPONENT, StewartSettings.State::class.java))
    }

    // --- settings ---

    @Test
    fun `settings migrate from the legacy file and keep it`() {
        val f = legacySettings(
            "<option name=\"ollamaUrl\" value=\"http://old:1\"/>" +
                "<option name=\"aifModels\"><list><option value=\"m1\"/></list></option>" +
                "<option name=\"debugLogEnabled\" value=\"true\"/>",
        )
        val settings = StewartSettings()
        assertTrue(settings.migrateLegacy(f))
        assertEquals("http://old:1", settings.state.ollamaUrl)
        assertEquals(listOf("m1"), settings.state.aifModels)
        assertTrue(settings.state.debugLogEnabled)
        assertTrue(Files.exists(f))
    }

    @Test
    fun `settings migration is a no-op without a legacy file`() {
        val settings = StewartSettings()
        assertFalse(settings.migrateLegacy(dir.resolve(LegacyMigration.SETTINGS_FILE)))
        assertEquals("http://localhost:11434", settings.state.ollamaUrl)
    }

    @Test
    fun `settings migration does not overwrite new state`() {
        val f = legacySettings("<option name=\"ollamaUrl\" value=\"http://old:1\"/>")
        val settings = StewartSettings()
        settings.state.claudeCliPath = "/usr/bin/claude"
        assertFalse(settings.migrateLegacy(f))
        assertEquals("http://localhost:11434", settings.state.ollamaUrl)
        assertEquals("/usr/bin/claude", settings.state.claudeCliPath)
    }

    @Test
    fun `noStateLoaded tolerates a missing options file`() {
        val settings = StewartSettings()
        settings.noStateLoaded()
        assertEquals("http://localhost:11434", settings.state.ollamaUrl)
    }

    // --- credential ---

    private val target = CredentialAttributes("new")
    private val legacy = CredentialAttributes("old")

    private fun store(vararg entries: Pair<CredentialAttributes, Credentials>) =
        mutableMapOf<String, Credentials>().apply { entries.forEach { (a, c) -> put(a.serviceName, c) } }

    @Test
    fun `credential already set is returned without touching the old one`() {
        val s = store(target to Credentials("aif", "new-key"), legacy to Credentials("aif", "old-key"))
        val got = LegacyMigration.migrateCredential(target, legacy, { s[it.serviceName] }, { a, c -> s[a.serviceName] = c })
        assertEquals("new-key", got?.getPasswordAsString())
        assertEquals("old-key", s["old"]?.getPasswordAsString())
    }

    @Test
    fun `empty credential is copied from the legacy entry with its user name`() {
        val s = store(legacy to Credentials("aif", "old-key"))
        val got = LegacyMigration.migrateCredential(target, legacy, { s[it.serviceName] }, { a, c -> s[a.serviceName] = c })
        assertEquals("old-key", got?.getPasswordAsString())
        assertEquals("old-key", s["new"]?.getPasswordAsString())
        assertEquals("aif", s["new"]?.userName)
        assertEquals("old-key", s["old"]?.getPasswordAsString())
    }

    @Test
    fun `blank new credential is replaced by the legacy one`() {
        val s = store(target to Credentials("aif", ""), legacy to Credentials("aif", "old-key"))
        val got = LegacyMigration.migrateCredential(target, legacy, { s[it.serviceName] }, { a, c -> s[a.serviceName] = c })
        assertEquals("old-key", got?.getPasswordAsString())
    }

    @Test
    fun `no credential anywhere writes nothing`() {
        val s = store(legacy to Credentials("aif", ""))
        val got = LegacyMigration.migrateCredential(target, legacy, { s[it.serviceName] }, { a, c -> s[a.serviceName] = c })
        assertNull(got)
        assertNull(s["new"])
    }

    // --- history ---

    @Test
    fun `history is copied when the new dir is missing and the old dir is kept`() {
        val old = dir.resolve(LegacyMigration.HISTORY_DIR).resolve("history")
        Files.createDirectories(old.resolve("nested"))
        val f = old.resolve("h.json").also { Files.writeString(it, "{}") }
        Files.writeString(old.resolve("nested").resolve("n.json"), "[]")
        val mtime = FileTime.fromMillis(1_000_000_000_000)
        Files.setLastModifiedTime(f, mtime)
        assertTrue(ChatHistoryStore.migrateLegacy(dir))
        val copied = ChatHistoryStore.pathFor(dir, "h")
        assertEquals("{}", Files.readString(copied))
        assertEquals(mtime, Files.getLastModifiedTime(copied))
        assertEquals("[]", Files.readString(ChatHistoryStore.historyDir(dir).resolve("nested").resolve("n.json")))
        assertTrue(Files.exists(f))
        assertFalse(Files.exists(dir.resolve("stewart").resolve("history.migrating")))
    }

    @Test
    fun `history copy is skipped when the old dir is absent`() {
        assertFalse(ChatHistoryStore.migrateLegacy(dir))
        assertFalse(Files.exists(ChatHistoryStore.historyDir(dir)))
    }

    @Test
    fun `history copy is skipped when the new dir already exists`() {
        val old = dir.resolve(LegacyMigration.HISTORY_DIR).resolve("history")
        Files.createDirectories(old)
        Files.writeString(old.resolve("h.json"), "{}")
        Files.createDirectories(ChatHistoryStore.historyDir(dir))
        assertFalse(ChatHistoryStore.migrateLegacy(dir))
        assertFalse(Files.exists(ChatHistoryStore.pathFor(dir, "h")))
    }

    @Test
    fun `failed history copy leaves no target so it is retried`() {
        val old = dir.resolve("old")
        Files.createDirectories(old)
        Files.writeString(old.resolve("h.json"), "{}")
        val blocker = dir.resolve("blocker").also { Files.writeString(it, "x") }
        assertFalse(LegacyMigration.copyDir(old, blocker.resolve("history")))
        assertFalse(Files.exists(blocker.resolve("history")))
    }

    @Test
    fun `stale staging dir is replaced`() {
        val old = dir.resolve("old")
        Files.createDirectories(old)
        Files.writeString(old.resolve("h.json"), "{}")
        val staging = dir.resolve("new.migrating")
        Files.createDirectories(staging)
        Files.writeString(staging.resolve("stale.json"), "x")
        assertTrue(LegacyMigration.copyDir(old, dir.resolve("new")))
        assertFalse(Files.exists(dir.resolve("new").resolve("stale.json")))
        assertFalse(Files.exists(staging))
    }
}

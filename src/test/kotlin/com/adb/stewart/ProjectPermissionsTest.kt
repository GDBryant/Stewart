package com.adb.stewart

import com.adb.stewart.settings.LegacyMigration
import com.adb.stewart.tools.ToolPreview
import com.adb.stewart.tools.permissions.ApprovalCategory
import com.adb.stewart.tools.permissions.ProjectPermissions
import com.adb.stewart.tools.permissions.categoryOf
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.xmlb.XmlSerializer
import java.io.File
import java.util.Collections

class ProjectPermissionsTest : BasePlatformTestCase() {

    private val permissions get() = ProjectPermissions.getInstance()

    override fun setUp() {
        super.setUp()
        permissions.resetForTest()
    }

    override fun tearDown() {
        try {
            permissions.resetForTest()
        } finally {
            super.tearDown()
        }
    }

    fun `test categoryOf maps every preview type`() {
        assertEquals(ApprovalCategory.EDITS, categoryOf(ToolPreview.FileChange("/p/f.txt", null, "x")))
        assertEquals(ApprovalCategory.COMMANDS, categoryOf(ToolPreview.Command("ls", "/p")))
        assertEquals(ApprovalCategory.OTHER, categoryOf(ToolPreview.Other))
        assertNull(categoryOf(null))
    }

    fun `test projects are isolated by location hash`() {
        permissions.setTick(project, ApprovalCategory.EDITS, true)
        permissions.addProgram(project, "git")
        val snapshot = permissions.forProject(project)
        assertEquals(setOf(ApprovalCategory.EDITS), snapshot.ticks)
        assertEquals(setOf("git"), snapshot.programs)
        val other = permissions.forHash("other-hash")
        assertTrue(other.ticks.isEmpty())
        assertTrue(other.programs.isEmpty())
    }

    fun `test writes bump the modification count so the state is saved`() {
        val before = permissions.state.modificationCount
        permissions.setTick(project, ApprovalCategory.EDITS, true)
        permissions.addProgram(project, "git")
        permissions.removeProgram(project, "git")
        permissions.resetProject(project)
        assertTrue(permissions.state.modificationCount > before)
    }

    fun `test xml round trip`() {
        val state = ProjectPermissions.State()
        state.migrated = true
        state.paths["h1"] = "/p"
        state.ticks["h1"] = "COMMANDS,EDITS"
        state.programs["h1"] = "./gradlew\ngit"
        val xml = XmlSerializer.serialize(state)
        val loaded = XmlSerializer.deserialize(xml, ProjectPermissions.State::class.java)
        assertTrue(loaded.migrated)
        assertEquals("/p", loaded.paths["h1"])
        assertEquals(setOf("COMMANDS", "EDITS"), loaded.ticks["h1"]!!.split(",").toSet())
        assertEquals(setOf("./gradlew", "git"), loaded.programs["h1"]!!.split("\n").toSet())
    }

    fun `test a planted idea file does not enable bypass`() {
        val idea = File(project.basePath, ".idea")
        idea.mkdirs()
        File(idea, "stewart-permissions.xml").writeText(
            "<application><component name=\"StewartPermissions\">" +
                "<option name=\"ticks\"><map><entry key=\"${project.locationHash}\" value=\"EDITS\"/></map></option>" +
                "</component></application>")
        val snapshot = permissions.forProject(project)
        assertTrue(snapshot.ticks.isEmpty())
        assertTrue(snapshot.programs.isEmpty())
    }

    fun `test a planted legacy idea file is not migrated`() {
        val idea = File(project.basePath, ".idea")
        idea.mkdirs()
        File(idea, LegacyMigration.PERMISSIONS_FILE).writeText(legacyXml(migrated = true, ticks = "EDITS"))
        assertFalse(LegacyMigration.optionsFile(LegacyMigration.PERMISSIONS_FILE).startsWith(project.basePath!!))
        permissions.noStateLoaded()
        assertTrue(permissions.forProject(project).ticks.isEmpty())
    }

    fun `test legacy file migrates grants and keeps the old file`() {
        val old = legacyFile(legacyXml(migrated = true, ticks = "COMMANDS,EDITS", programs = "git"))
        val fresh = ProjectPermissions()
        assertTrue(fresh.migrateLegacy(old))
        assertTrue(fresh.state.migrated)
        assertEquals(setOf(ApprovalCategory.COMMANDS, ApprovalCategory.EDITS), fresh.forHash(project.locationHash).ticks)
        assertEquals(setOf("git"), fresh.forHash(project.locationHash).programs)
        assertTrue(old.toFile().exists())
    }

    fun `test migrated flag from the legacy file prevents reseeding`() {
        val old = legacyFile(legacyXml(migrated = true, ticks = "COMMANDS"))
        val fresh = ProjectPermissions()
        fresh.autoApproveEdits = { true }
        fresh.openProjects = { listOf(project) }
        assertTrue(fresh.migrateLegacy(old))
        assertEquals(setOf(ApprovalCategory.COMMANDS), fresh.forProject(project).ticks)
    }

    fun `test legacy file without the migrated flag still seeds once`() {
        val old = legacyFile(legacyXml(migrated = false, ticks = "COMMANDS"))
        val fresh = ProjectPermissions()
        fresh.autoApproveEdits = { true }
        fresh.openProjects = { listOf(project) }
        assertTrue(fresh.migrateLegacy(old))
        assertEquals(setOf(ApprovalCategory.COMMANDS, ApprovalCategory.EDITS), fresh.forProject(project).ticks)
    }

    fun `test legacy migration skips when the old file is absent`() {
        val fresh = ProjectPermissions()
        assertFalse(fresh.migrateLegacy(File(createTempDir(), "missing.xml").toPath()))
        assertFalse(fresh.state.migrated)
        assertTrue(fresh.forHash(project.locationHash).ticks.isEmpty())
    }

    fun `test legacy migration skips when new state is already set`() {
        val old = legacyFile(legacyXml(migrated = true, ticks = "EDITS"))
        val fresh = ProjectPermissions()
        fresh.addProgramForHash("h2", "make")
        assertFalse(fresh.migrateLegacy(old))
        assertTrue(fresh.forHash(project.locationHash).ticks.isEmpty())
        assertEquals(setOf("make"), fresh.forHash("h2").programs)
    }

    fun `test loadState rebuilds snapshots`() {
        val state = ProjectPermissions.State()
        state.migrated = true
        state.ticks["h1"] = "EDITS"
        val fresh = ProjectPermissions()
        fresh.loadState(state)
        assertEquals(setOf(ApprovalCategory.EDITS), fresh.forHash("h1").ticks)
    }

    private fun legacyXml(migrated: Boolean, ticks: String, programs: String? = null): String {
        val h = project.locationHash
        return "<application><component name=\"${LegacyMigration.PERMISSIONS_COMPONENT}\">" +
            (if (migrated) "<option name=\"migrated\" value=\"true\"/>" else "") +
            "<option name=\"ticks\"><map><entry key=\"$h\" value=\"$ticks\"/></map></option>" +
            (programs?.let { "<option name=\"programs\"><map><entry key=\"$h\" value=\"$it\"/></map></option>" } ?: "") +
            "</component></application>"
    }

    private fun legacyFile(xml: String) = File(createTempDir(), LegacyMigration.PERMISSIONS_FILE).apply { writeText(xml) }.toPath()

    private fun createTempDir(): File = java.nio.file.Files.createTempDirectory("stewart-perms-").toFile().also { it.deleteOnExit() }

    fun `test concurrent reads and writes stay consistent`() {
        val failures = Collections.synchronizedList(mutableListOf<Throwable>())
        val writer = Thread {
            repeat(100) { i ->
                try {
                    permissions.addProgram(project, "p$i")
                } catch (t: Throwable) {
                    failures.add(t)
                }
            }
        }
        val readers = (1..4).map {
            Thread {
                repeat(200) {
                    try {
                        permissions.forProject(project)
                    } catch (t: Throwable) {
                        failures.add(t)
                    }
                }
            }
        }
        (readers + writer).forEach(Thread::start)
        (readers + writer).forEach { it.join(30_000) }
        assertTrue(failures.isEmpty())
        assertEquals((0 until 100).map { "p$it" }.toSet(), permissions.forProject(project).programs)
    }

    fun `test a moved project starts empty and is not reseeded`() {
        permissions.autoApproveEdits = { true }
        permissions.openProjects = { listOf(project) }
        permissions.forProject(project)
        permissions.setTick(project, ApprovalCategory.EDITS, false)
        val moved = permissions.forHash(project.locationHash + "-moved")
        assertTrue(moved.ticks.isEmpty())
        assertTrue(moved.programs.isEmpty())
    }

    fun `test legacy trusted mode seeds edits once for open projects`() {
        permissions.autoApproveEdits = { true }
        permissions.openProjects = { listOf(project) }
        assertTrue(permissions.forProject(project).covers(ApprovalCategory.EDITS))
        assertTrue(permissions.state.migrated)
        permissions.setTick(project, ApprovalCategory.EDITS, false)
        assertFalse(permissions.forProject(project).covers(ApprovalCategory.EDITS))
        assertTrue(permissions.forProject(project).ticks.isEmpty())
    }

    fun `test legacy false seeds nothing`() {
        permissions.autoApproveEdits = { false }
        permissions.openProjects = { listOf(project) }
        assertTrue(permissions.forProject(project).ticks.isEmpty())
        assertTrue(permissions.state.migrated)
    }

    fun `test a project opened after migration gets nothing`() {
        permissions.autoApproveEdits = { true }
        permissions.openProjects = { listOf(project) }
        permissions.forProject(project)
        assertTrue(permissions.forHash("opened-later").ticks.isEmpty())
    }

    fun `test migration with no open project sets the flag and seeds nothing`() {
        permissions.autoApproveEdits = { true }
        permissions.openProjects = { emptyList() }
        assertTrue(permissions.forProject(project).ticks.isEmpty())
        assertTrue(permissions.state.migrated)
    }

    fun `test migration runs once even on repeated reads`() {
        permissions.autoApproveEdits = { true }
        var calls = 0
        permissions.openProjects = { calls++; listOf(project) }
        permissions.forProject(project)
        permissions.forProject(project)
        assertEquals(1, calls)
    }

    fun `test resetProject removes only its own entry`() {
        permissions.addProgram(project, "git")
        permissions.setTickForHash("other", ApprovalCategory.COMMANDS, true)
        permissions.resetProject(project)
        assertTrue(permissions.forProject(project).programs.isEmpty())
        assertNull(permissions.pathFor(project))
        assertTrue(permissions.forHash("other").covers(ApprovalCategory.COMMANDS))
    }

    fun `test resetAll removes every entry`() {
        permissions.addProgram(project, "git")
        permissions.setTickForHash("other", ApprovalCategory.COMMANDS, true)
        permissions.resetAll()
        assertTrue(permissions.forProject(project).programs.isEmpty())
        assertTrue(permissions.forHash("other").ticks.isEmpty())
    }

    fun `test changes are published through the listener topic`() {
        val seen = Collections.synchronizedList(mutableListOf<String>())
        com.intellij.openapi.application.ApplicationManager.getApplication().messageBus
            .connect(testRootDisposable)
            .subscribe(ProjectPermissions.TOPIC,
                com.adb.stewart.tools.permissions.PermissionsListener { seen.add(it) })
        permissions.addProgram(project, "git")
        permissions.resetProject(project)
        assertEquals(listOf(project.locationHash, project.locationHash), seen)
    }

    fun `test snapshot helpers`() {
        permissions.addProgram(project, "git")
        permissions.setTick(project, ApprovalCategory.EDITS, true)
        val snapshot = permissions.forProject(project)
        assertTrue(snapshot.covers(ApprovalCategory.EDITS))
        assertFalse(snapshot.covers(ApprovalCategory.COMMANDS))
        assertTrue(snapshot.coversPrograms(listOf("git")))
        assertFalse(snapshot.coversPrograms(listOf("git", "rm")))
    }
}

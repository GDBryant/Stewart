package com.aijb.assistant

import com.aijb.assistant.tools.ToolPreview
import com.aijb.assistant.tools.permissions.ApprovalCategory
import com.aijb.assistant.tools.permissions.ProjectPermissions
import com.aijb.assistant.tools.permissions.categoryOf
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
        File(idea, "aijb-permissions.xml").writeText(
            "<application><component name=\"AijbPermissions\">" +
                "<option name=\"ticks\"><map><entry key=\"x\" value=\"EDITS\"/></map></option>" +
                "</component></application>")
        val snapshot = permissions.forProject(project)
        assertTrue(snapshot.ticks.isEmpty())
        assertTrue(snapshot.programs.isEmpty())
    }

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
                com.aijb.assistant.tools.permissions.PermissionsListener { seen.add(it) })
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

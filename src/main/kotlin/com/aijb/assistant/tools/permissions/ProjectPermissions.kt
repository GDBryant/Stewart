package com.aijb.assistant.tools.permissions

import com.aijb.assistant.settings.AijbSettings
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SettingsCategory
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.util.messages.Topic

fun interface PermissionsListener {
    /** [projectHash] is the changed project's locationHash; empty means every project. */
    fun permissionsChanged(projectHash: String)
}

/** Immutable view of one project's bypass state; safe to read off the EDT. */
data class PermissionsSnapshot(
    val ticks: Set<ApprovalCategory> = emptySet(),
    val programs: Set<String> = emptySet(),
) {
    fun covers(category: ApprovalCategory): Boolean = category in ticks
    fun coversPrograms(needed: Collection<String>): Boolean = programs.containsAll(needed)
}

/**
 * Per-project bypass ticks and always-granted programs, keyed by `project.locationHash` and kept in
 * application-level state so a repository cannot ship them. `SettingsCategory.SYSTEM` keeps the file
 * out of Settings Sync: a hash is meaningless on another machine.
 *
 * Reads return an immutable [PermissionsSnapshot] published through a volatile map. Writes are
 * synchronised and expected from the EDT (dialogs, toggle, settings page); they mark the state
 * modified so the component is saved, then publish through [TOPIC].
 */
@Service(Service.Level.APP)
@State(
    name = "AijbPermissions",
    storages = [Storage("aijb-permissions.xml")],
    category = SettingsCategory.SYSTEM,
)
class ProjectPermissions : SimplePersistentStateComponent<ProjectPermissions.State>(State()) {

    class State : BaseState() {
        /** App-wide one-shot migration flag; not per project so a moved project is never re-seeded. */
        var migrated by property(false)
        /** locationHash -> project path, kept for display only. */
        var paths by map<String, String>()
        /** locationHash -> comma-separated [ApprovalCategory] names. */
        var ticks by map<String, String>()
        /** locationHash -> newline-joined program grants (a program token never contains a newline). */
        var programs by map<String, String>()
    }

    private val defaultAutoApprove: () -> Boolean = { AijbSettings.getInstance().state.autoApproveEdits }
    private val defaultOpenProjects: () -> List<Project> = { ProjectManager.getInstance().openProjects.toList() }

    /** Test seams for the legacy setting and the open-project list used by migration. */
    internal var autoApproveEdits: () -> Boolean = defaultAutoApprove
    internal var openProjects: () -> List<Project> = defaultOpenProjects

    private val sync = Any()

    @Volatile
    private var snapshots: Map<String, PermissionsSnapshot> = emptyMap()

    /** The project's snapshot; the first call after upgrade runs the one-shot migration. */
    fun forProject(project: Project): PermissionsSnapshot {
        ensureMigrated()
        return forHash(project.locationHash)
    }

    internal fun forHash(hash: String): PermissionsSnapshot =
        snapshots[hash] ?: PermissionsSnapshot()

    fun pathFor(project: Project): String? = synchronized(sync) { state.paths[project.locationHash] }

    fun setTick(project: Project, category: ApprovalCategory, enabled: Boolean) {
        ensureMigrated()
        synchronized(sync) { writePath(project.locationHash, project.basePath.orEmpty()) }
        setTickForHash(project.locationHash, category, enabled)
    }

    fun addProgram(project: Project, program: String) {
        ensureMigrated()
        synchronized(sync) { writePath(project.locationHash, project.basePath.orEmpty()) }
        addProgramForHash(project.locationHash, program)
    }

    fun removeProgram(project: Project, program: String) {
        removeProgramForHash(project.locationHash, program)
    }

    fun resetProject(project: Project) = resetHash(project.locationHash)

    fun resetAll() {
        synchronized(sync) {
            state.paths = mutableMapOf()
            state.ticks = mutableMapOf()
            state.programs = mutableMapOf()
            rebuild()
        }
        publish("")
    }

    internal fun setTickForHash(hash: String, category: ApprovalCategory, enabled: Boolean) {
        synchronized(sync) {
            val set = tickSet(hash)
            if (enabled) set.add(category.name) else set.remove(category.name)
            writeTicks(hash, set)
            rebuild()
        }
        publish(hash)
    }

    internal fun addProgramForHash(hash: String, program: String) {
        synchronized(sync) {
            val set = programSet(hash)
            if (set.add(program)) writePrograms(hash, set)
            rebuild()
        }
        publish(hash)
    }

    internal fun removeProgramForHash(hash: String, program: String) {
        synchronized(sync) {
            val set = programSet(hash)
            if (set.remove(program)) writePrograms(hash, set)
            rebuild()
        }
        publish(hash)
    }

    internal fun resetHash(hash: String) {
        synchronized(sync) {
            state.paths = state.paths.toMutableMap().apply { remove(hash) }
            state.ticks = state.ticks.toMutableMap().apply { remove(hash) }
            state.programs = state.programs.toMutableMap().apply { remove(hash) }
            rebuild()
        }
        publish(hash)
    }

    /** One-shot app-wide migration: a legacy `autoApproveEdits = true` seeds EDITS for open projects only. */
    private fun ensureMigrated() {
        val seeded: List<String>
        synchronized(sync) {
            if (state.migrated) return
            state.migrated = true
            val legacy = try {
                autoApproveEdits()
            } catch (e: Throwable) {
                LOG.warn("Could not read legacy autoApproveEdits: ${e.javaClass.simpleName}")
                false
            }
            val projects = if (legacy) {
                try {
                    openProjects()
                } catch (e: Throwable) {
                    LOG.warn("Could not list open projects for permissions migration: ${e.javaClass.simpleName}")
                    emptyList()
                }
            } else {
                emptyList()
            }
            for (p in projects) {
                writePath(p.locationHash, p.basePath.orEmpty())
                val set = tickSet(p.locationHash)
                if (set.add(ApprovalCategory.EDITS.name)) writeTicks(p.locationHash, set)
            }
            seeded = projects.map { it.locationHash }
            rebuild()
        }
        seeded.forEach(::publish)
    }

    private fun tickSet(hash: String): MutableSet<String> =
        state.ticks[hash]?.split(',')?.filter { it.isNotEmpty() }?.toMutableSet() ?: mutableSetOf()

    /**
     * All writes replace the top-level property: mutating the nested map in place never bumps the
     * component's modification count, so the change would silently not be saved.
     */
    private fun writePath(hash: String, path: String) {
        state.paths = state.paths.toMutableMap().apply { put(hash, path) }
    }

    private fun writeTicks(hash: String, set: Set<String>) {
        val map = state.ticks.toMutableMap()
        if (set.isEmpty()) map.remove(hash) else map[hash] = set.sorted().joinToString(",")
        state.ticks = map
    }

    private fun programSet(hash: String): MutableSet<String> =
        state.programs[hash]?.split('\n')?.filter { it.isNotEmpty() }?.toMutableSet() ?: mutableSetOf()

    private fun writePrograms(hash: String, set: Set<String>) {
        val map = state.programs.toMutableMap()
        if (set.isEmpty()) map.remove(hash) else map[hash] = set.sorted().joinToString("\n")
        state.programs = map
    }

    private fun rebuild() {
        val result = HashMap<String, PermissionsSnapshot>()
        for (hash in state.ticks.keys + state.programs.keys) {
            val ticks = tickSet(hash)
                .mapNotNull { name -> ApprovalCategory.entries.firstOrNull { it.name == name } }
                .toSet()
            result[hash] = PermissionsSnapshot(ticks, programSet(hash))
        }
        snapshots = result
    }

    private fun publish(hash: String) {
        try {
            ApplicationManager.getApplication().messageBus
                .syncPublisher(TOPIC).permissionsChanged(hash)
        } catch (e: Throwable) {
            LOG.warn("Could not publish permissions change: ${e.javaClass.simpleName}")
        }
    }

    internal fun resetForTest() {
        synchronized(sync) {
            state.paths = mutableMapOf()
            state.ticks = mutableMapOf()
            state.programs = mutableMapOf()
            state.migrated = false
            rebuild()
            autoApproveEdits = defaultAutoApprove
            openProjects = defaultOpenProjects
        }
    }

    companion object {
        val TOPIC: Topic<PermissionsListener> =
            Topic(PermissionsListener::class.java, Topic.BroadcastDirection.NONE)

        private val LOG = Logger.getInstance(ProjectPermissions::class.java)

        fun getInstance(): ProjectPermissions = service()
    }
}

package com.adb.stewart.settings

import com.adb.stewart.agents.AgentRole
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.claude.ClaudeModels
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.util.messages.Topic
import java.nio.file.Path

fun interface StewartSettingsListener {
    fun settingsChanged()
}

@Service(Service.Level.APP)
@State(name = "StewartSettings", storages = [Storage("stewart.xml")])
class StewartSettings : SimplePersistentStateComponent<StewartSettings.State>(State()) {

    class State : BaseState() {
        var ollamaUrl by string("http://localhost:11434")
        var aifBaseUrl by string("")
        var aifModels by list<String>()
        var claudeCliPath by string("claude")
        var claudeModels by list<String>()
        var toolPathOverrides by map<String, String>()

        /** Models forced to accept images, stored as `providerId/modelId` (e.g. `aif/my-model`), like toolPathOverrides keys. */
        var visionModelOverrides by stringSet()
        var multiModel by property(false)
        var chatModel by string()
        var plannerModel by string()
        var executorModel by string()
        var workerModel by string()
        var effort by string(EffortLevel.DEFAULT.name)
        var roleEffort by map<String, String>()
        var autoCompactTokens by property(80000)
        var autoApproveEdits by property(false)
        var historyRetentionDays by property(30)
        var toolsEnabled by property(true)
        var debugLogEnabled by property(false)
        var debugLogFolder by string("./log/debug_logs/")
        var debugLogRetentionDays by property(7)

        /** Per-model Ollama `num_ctx`, keyed `ollama/<model>` like toolPathOverrides; values are decimal strings. */
        var ollamaNumCtx by map<String, String>()
        var maxWorkerTurnsCeiling by property(DEFAULT_WORKER_TURNS_CEILING)
        var askOnTurnLimit by property(true)
        /** Minutes to wait for an answer to a turn-limit question; 0 waits forever. */
        var continueQuestionTimeoutMinutes by property(5)
    }

    /** No `stewart.xml` yet: adopt the pre-rename `aijb-assistant.xml` once. */
    override fun noStateLoaded() {
        migrateLegacy(LegacyMigration.optionsFile(LegacyMigration.SETTINGS_FILE))
    }

    internal fun migrateLegacy(file: Path): Boolean =
        LegacyMigration.migrateState(state, State(), file, LegacyMigration.SETTINGS_COMPONENT, ::loadState)

    override fun loadState(state: State) {
        super.loadState(state)
        migrateClaudeModels()
    }

    internal fun migrateClaudeModels() {
        state.claudeModels = state.claudeModels
            .map { ClaudeModels.normalize(it) }.distinct().toMutableList()
        fun migrateRef(value: String?): String? {
            val ref = ModelRef.decode(value) ?: return value
            if (ref.providerId != "claude") return value
            return ModelRef("claude", ClaudeModels.normalize(ref.modelId)).encode()
        }
        state.chatModel = migrateRef(state.chatModel)
        state.plannerModel = migrateRef(state.plannerModel)
        state.executorModel = migrateRef(state.executorModel)
        state.workerModel = migrateRef(state.workerModel)
    }

    val effectiveClaudeModels: List<String>
        get() = state.claudeModels.ifEmpty { DEFAULT_CLAUDE_MODELS }

    val effortLevel: EffortLevel
        get() = EffortLevel.parse(state.effort) ?: EffortLevel.DEFAULT

    fun effortFor(role: AgentRole): EffortLevel =
        if (state.multiModel) effortLevel.forRole(role, state.roleEffort) else effortLevel

    fun roleModel(role: AgentRole): ModelRef? = ModelRef.decode(
        when (role) {
            AgentRole.PLANNER -> state.plannerModel
            AgentRole.EXECUTOR -> state.executorModel
            AgentRole.WORKER -> state.workerModel
        }
    )

    fun setRoleModel(role: AgentRole, ref: ModelRef?) {
        when (role) {
            AgentRole.PLANNER -> state.plannerModel = ref?.encode()
            AgentRole.EXECUTOR -> state.executorModel = ref?.encode()
            AgentRole.WORKER -> state.workerModel = ref?.encode()
        }
    }

    /** Fills unset role bindings from the single-model picker, so enabling multi-model starts coherent. */
    fun seedRoleModels() {
        val chat = ModelRef.decode(state.chatModel) ?: return
        AgentRole.entries.filter { roleModel(it) == null }.forEach { setRoleModel(it, chat) }
    }

    fun toolPathOverride(ref: ModelRef): String? = state.toolPathOverrides[ref.encode()]

    companion object {
        val DEFAULT_CLAUDE_MODELS = listOf("sonnet", "opus", "haiku")

        const val DEFAULT_WORKER_TURNS_CEILING = 60
        val WORKER_TURNS_CEILING_RANGE = 5..200
        val CONTINUE_TIMEOUT_RANGE = 0..1440
        val NUM_CTX_RANGE = 512..1048576

        /** Clamps a stored worker turn ceiling into its allowed range. */
        fun clampWorkerTurnsCeiling(value: Int): Int = value.coerceIn(WORKER_TURNS_CEILING_RANGE)

        val TOPIC: Topic<StewartSettingsListener> =
            Topic(StewartSettingsListener::class.java, Topic.BroadcastDirection.NONE)

        fun getInstance(): StewartSettings = service()
    }
}

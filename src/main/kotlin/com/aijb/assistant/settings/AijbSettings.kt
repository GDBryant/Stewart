package com.aijb.assistant.settings

import com.aijb.assistant.provider.ModelRef
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.util.messages.Topic

fun interface AijbSettingsListener {
    fun settingsChanged()
}

@Service(Service.Level.APP)
@State(name = "AijbAssistantSettings", storages = [Storage("aijb-assistant.xml")])
class AijbSettings : SimplePersistentStateComponent<AijbSettings.State>(State()) {

    class State : BaseState() {
        var ollamaUrl by string("http://localhost:11434")
        var aifBaseUrl by string("")
        var aifModels by list<String>()
        var claudeCliPath by string("claude")
        var claudeModels by list<String>()
        var toolPathOverrides by map<String, String>()
        var multiModel by property(false)
        var chatModel by string()
        var plannerModel by string()
        var executorModel by string()
        var workerModel by string()
        var autoCompactTokens by property(80000)
        var autoApproveEdits by property(false)
        var historyRetentionDays by property(30)
        var toolsEnabled by property(true)
    }

    val effectiveClaudeModels: List<String>
        get() = state.claudeModels.ifEmpty { DEFAULT_CLAUDE_MODELS }

    fun toolPathOverride(ref: ModelRef): String? = state.toolPathOverrides[ref.encode()]

    companion object {
        val DEFAULT_CLAUDE_MODELS = listOf("sonnet", "opus", "haiku")

        val TOPIC: Topic<AijbSettingsListener> =
            Topic(AijbSettingsListener::class.java, Topic.BroadcastDirection.NONE)

        fun getInstance(): AijbSettings = service()
    }
}

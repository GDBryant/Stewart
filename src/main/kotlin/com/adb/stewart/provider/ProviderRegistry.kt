package com.adb.stewart.provider

import com.adb.stewart.provider.aif.AifProvider
import com.adb.stewart.provider.claude.ClaudeProvider
import com.adb.stewart.provider.ollama.OllamaProvider
import com.adb.stewart.settings.AijbSettings
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service

@Service(Service.Level.APP)
class ProviderRegistry @JvmOverloads constructor(
    private val settingsState: () -> AijbSettings.State = { AijbSettings.getInstance().state },
) {

    private data class Snapshot(
        val ollamaUrl: String,
        val aifBaseUrl: String,
        val aifModels: List<String>,
        val claudeCliPath: String,
        val claudeModels: List<String>,
        val toolPathOverrides: Map<String, String>,
    )

    @Volatile
    private var cached: Pair<Snapshot, List<ModelProvider>>? = null

    private fun snapshot(): Snapshot {
        val s = settingsState()
        return Snapshot(
            ollamaUrl = s.ollamaUrl ?: "",
            aifBaseUrl = s.aifBaseUrl ?: "",
            aifModels = s.aifModels.toList(),
            claudeCliPath = s.claudeCliPath ?: "claude",
            claudeModels = s.claudeModels.ifEmpty { AijbSettings.DEFAULT_CLAUDE_MODELS },
            toolPathOverrides = s.toolPathOverrides.toMap(),
        )
    }

    private fun build(snap: Snapshot): List<ModelProvider> {
        val list = mutableListOf<ModelProvider>(
            OllamaProvider(snap.ollamaUrl),
            ClaudeProvider(cliPath = snap.claudeCliPath, models = snap.claudeModels),
        )
        if (snap.aifBaseUrl.isNotBlank()) {
            list.add(AifProvider(
                snap.aifBaseUrl,
                snap.aifModels,
                nativeTools = { m -> snap.toolPathOverrides["aif/$m"]?.equals("SHIM", true) != true },
            ))
        }
        return list
    }

    fun providers(): List<ModelProvider> {
        val snap = snapshot()
        cached?.let { if (it.first == snap) return it.second }
        synchronized(this) {
            cached?.let { if (it.first == snap) return it.second }
            val built = build(snap)
            cached = snap to built
            return built
        }
    }

    fun provider(id: String): ModelProvider? = providers().firstOrNull { it.id == id }

    companion object {
        fun getInstance(): ProviderRegistry = service()
    }
}

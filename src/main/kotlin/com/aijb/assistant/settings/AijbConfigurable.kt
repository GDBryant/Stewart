package com.aijb.assistant.settings

import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.aif.AifCredentials
import com.aijb.assistant.provider.aif.AifUrls
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.panel
import javax.swing.JButton
import javax.swing.JLabel

class AijbConfigurable : BoundConfigurable("AIJB Assistant") {

    private val settings get() = AijbSettings.getInstance()

    internal lateinit var ollamaUrlField: JBTextField
    internal lateinit var aifBaseUrlField: JBTextField
    internal lateinit var apiKeyField: JBPasswordField
    internal lateinit var apiKeyStatus: JLabel
    internal lateinit var clearKeyButton: JButton
    internal lateinit var aifModelsArea: JBTextArea
    internal lateinit var claudeCliPathField: JBTextField
    internal lateinit var claudeModelsArea: JBTextArea
    internal lateinit var overridesArea: JBTextArea
    internal lateinit var autoCompactField: JBTextField

    override fun createPanel(): DialogPanel = panel {
        row("Ollama URL:") { ollamaUrlField = textField().component }
        row("AIF base URL:") { aifBaseUrlField = textField().component }
        row("AIF API key:") {
            apiKeyField = passwordField().component
            apiKeyStatus = label("").component
            clearKeyButton = JButton("Clear stored key").also { button ->
                button.addActionListener {
                    AifCredentials.set(null)
                    apiKeyStatus.text = "Not set"
                }
                cell(button)
            }
        }
        row("AIF models (one per line):") { aifModelsArea = JBTextArea(4, 30).also { cell(JBScrollPane(it)) } }
        row("Claude CLI path:") { claudeCliPathField = textField().component }
        row("Claude models (one per line):") { claudeModelsArea = JBTextArea(4, 30).also { cell(JBScrollPane(it)) } }
        row("Tool path overrides:") { overridesArea = JBTextArea(4, 30).also { cell(JBScrollPane(it)) } }
        row("Auto-compact context at (tokens):") { autoCompactField = textField().component }
    }

    private fun overridesText(map: Map<String, String>): String =
        map.entries.joinToString("\n") { "${it.key}=${it.value}" }

    private fun parseOverrides(text: String): Map<String, String> {
        val map = linkedMapOf<String, String>()
        text.lines().forEachIndexed { i, raw ->
            val line = raw.trim()
            if (line.isEmpty()) return@forEachIndexed
            val eq = line.indexOf('=')
            val key = if (eq < 0) line else line.substring(0, eq).trim()
            val value = if (eq < 0) "" else line.substring(eq + 1).trim()
            val ref = ModelRef.decode(key)
                ?: throw ConfigurationException("Malformed override line ${i + 1}: $line")
            if (!value.equals("native", true) && !value.equals("shim", true)) {
                throw ConfigurationException("Malformed override line ${i + 1}: $line")
            }
            if (value.equals("native", true) && ref.providerId !in ToolPathResolver.NATIVE_CAPABLE) {
                throw ConfigurationException(
                    "NATIVE tool path is not supported for provider '${ref.providerId}'")
            }
            map[ref.encode()] = value.uppercase()
        }
        return map
    }

    override fun isModified(): Boolean {
        if (!::ollamaUrlField.isInitialized) return false
        val s = settings.state
        return ollamaUrlField.text.trim() != s.ollamaUrl.orEmpty().trim() ||
            aifBaseUrlField.text.trim() != s.aifBaseUrl.orEmpty().trim() ||
            apiKeyField.password.isNotEmpty() ||
            aifModelsArea.text.lines().map { it.trim() }.filter { it.isNotEmpty() } != s.aifModels ||
            claudeCliPathField.text.trim() != s.claudeCliPath.orEmpty().trim() ||
            claudeModelsArea.text.lines().map { it.trim() }.filter { it.isNotEmpty() } != s.claudeModels ||
            runCatching { parseOverrides(overridesArea.text) }.getOrNull() != s.toolPathOverrides ||
            TokenCount.parse(autoCompactField.text) != s.autoCompactTokens
    }

    override fun reset() {
        val s = settings.state
        ollamaUrlField.text = s.ollamaUrl
        aifBaseUrlField.text = s.aifBaseUrl
        apiKeyField.text = ""
        apiKeyStatus.text = if (AifCredentials.get() != null) "Stored" else "Not set"
        aifModelsArea.text = s.aifModels.joinToString("\n")
        claudeCliPathField.text = s.claudeCliPath
        claudeModelsArea.text = s.claudeModels.joinToString("\n")
        overridesArea.text = overridesText(s.toolPathOverrides)
        autoCompactField.text = TokenCount.format(s.autoCompactTokens)
    }

    override fun apply() {
        val ollama = ollamaUrlField.text.trim()
        if (!ollama.startsWith("http://") && !ollama.startsWith("https://")) {
            throw ConfigurationException("Ollama URL must be http(s)")
        }
        val aifBase = aifBaseUrlField.text.trim()
        if (aifBase.isNotBlank()) {
            try {
                AifUrls.chatCompletions(aifBase)
            } catch (e: IllegalArgumentException) {
                throw ConfigurationException("Invalid AIF base URL: ${e.message}")
            }
        }
        val overrides = parseOverrides(overridesArea.text)
        val autoCompact = TokenCount.parse(autoCompactField.text)
            ?: throw ConfigurationException("Invalid token count: ${autoCompactField.text}")

        val s = settings.state
        s.ollamaUrl = ollama
        s.aifBaseUrl = aifBase
        s.aifModels = aifModelsArea.text.lines().map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        s.claudeCliPath = claudeCliPathField.text.trim().ifBlank { "claude" }
        s.claudeModels = claudeModelsArea.text.lines().map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        s.toolPathOverrides = overrides.toMutableMap()
        s.autoCompactTokens = autoCompact

        val key = String(apiKeyField.password)
        if (key.isNotEmpty()) {
            AifCredentials.set(key)
            apiKeyField.text = ""
            apiKeyStatus.text = "Stored"
        }
        ApplicationManager.getApplication().messageBus
            .syncPublisher(AijbSettings.TOPIC).settingsChanged()
    }
}

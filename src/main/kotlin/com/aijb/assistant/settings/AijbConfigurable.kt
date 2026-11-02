package com.aijb.assistant.settings

import com.aijb.assistant.debug.DebugLogSink
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.aif.AifCredentials
import com.aijb.assistant.provider.aif.AifUrls
import com.aijb.assistant.provider.claude.ClaudeLoginState
import com.aijb.assistant.provider.claude.ClaudeProvider
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
    internal lateinit var claudeLoginStatus: JLabel
    internal lateinit var checkLoginButton: JButton
    internal lateinit var overridesArea: JBTextArea
    internal lateinit var autoCompactField: JBTextField
    internal lateinit var historyRetentionField: JBTextField
    internal lateinit var toolsEnabledCheck: javax.swing.JCheckBox
    internal lateinit var autoApproveCheck: javax.swing.JCheckBox
    internal lateinit var debugLogCheck: javax.swing.JCheckBox
    internal lateinit var debugLogFolderField: JBTextField
    internal lateinit var debugLogRetentionField: JBTextField

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
        row("AIF extra models (one per line):") { aifModelsArea = JBTextArea(4, 30).also { cell(JBScrollPane(it)) } }
        row("Claude CLI path:") { claudeCliPathField = textField().component }
        row("Claude login:") {
            claudeLoginStatus = label(UNCHECKED_LOGIN).component
            checkLoginButton = JButton("Check login").also { button ->
                button.addActionListener { checkLogin() }
                cell(button)
            }
        }
        row("Claude models (one per line):") { claudeModelsArea = JBTextArea(4, 30).also { cell(JBScrollPane(it)) } }
        row("Tool path overrides:") { overridesArea = JBTextArea(4, 30).also { cell(JBScrollPane(it)) } }
        row("Auto-compact context at (tokens):") { autoCompactField = textField().component }
        row("Keep chat history (days, 0 = don't save):") { historyRetentionField = textField().component }
        row {
            toolsEnabledCheck = checkBox("Enable tools (read, search, edit, run commands)").component
        }
        row {
            autoApproveCheck = checkBox("Trusted mode: auto-approve file edits (commands always ask)").component
        }
        row {
            debugLogCheck = checkBox("Debug log: record every model call (Ollama, AIF, Claude CLI)").component
        }
        row("Debug log folder:") { debugLogFolderField = textField().component }
        row("Debug log retention (days, 0 = keep forever):") { debugLogRetentionField = textField().component }
    }

    internal var loginStatusCheck: suspend (String) -> ClaudeLoginState =
        { path -> ClaudeProvider(path).loginStatus() }
    internal var loginCheckExecutor: ((() -> Unit) -> Unit) = { task ->
        ApplicationManager.getApplication().executeOnPooledThread(task)
    }

    internal fun checkLogin() {
        if (!::claudeLoginStatus.isInitialized) return
        claudeLoginStatus.text = "Checking…"
        val path = claudeCliPathField.text.trim().ifBlank { "claude" }
        val check = loginStatusCheck
        loginCheckExecutor {
            val state = try {
                kotlinx.coroutines.runBlocking { check(path) }
            } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                throw e
            } catch (e: Throwable) {
                ClaudeLoginState(false, null, null, e.message ?: e.javaClass.simpleName)
            }
            ApplicationManager.getApplication().invokeLater {
                if (::claudeLoginStatus.isInitialized) claudeLoginStatus.text = describeLogin(state)
            }
        }
    }

    internal fun describeLogin(state: ClaudeLoginState): String {
        if (!state.loggedIn) {
            return "Not logged in" + (state.detail?.let { ": $it" } ?: "")
        }
        val account = listOfNotNull(state.subscriptionType, state.authMethod).joinToString(", ")
        return if (account.isEmpty()) "Logged in" else "Logged in ($account)"
    }

    private fun overridesText(map: Map<String, String>): String =        map.entries.joinToString("\n") { "${it.key}=${it.value}" }

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
            TokenCount.parse(autoCompactField.text) != s.autoCompactTokens ||
            historyRetentionField.text.trim().toIntOrNull() != s.historyRetentionDays ||
            toolsEnabledCheck.isSelected != s.toolsEnabled ||
            autoApproveCheck.isSelected != s.autoApproveEdits ||
            debugLogCheck.isSelected != s.debugLogEnabled ||
            debugLogFolderField.text.trim() != s.debugLogFolder.orEmpty().trim() ||
            debugLogRetentionField.text.trim().toIntOrNull() != s.debugLogRetentionDays
    }

    override fun reset() {
        val s = settings.state
        ollamaUrlField.text = s.ollamaUrl
        aifBaseUrlField.text = s.aifBaseUrl
        apiKeyField.text = ""
        apiKeyStatus.text = if (AifCredentials.get() != null) "Stored" else "Not set"
        aifModelsArea.text = s.aifModels.joinToString("\n")
        claudeCliPathField.text = s.claudeCliPath
        claudeLoginStatus.text = UNCHECKED_LOGIN
        claudeModelsArea.text = s.claudeModels.joinToString("\n")
        overridesArea.text = overridesText(s.toolPathOverrides)
        autoCompactField.text = TokenCount.format(s.autoCompactTokens)
        historyRetentionField.text = s.historyRetentionDays.toString()
        toolsEnabledCheck.isSelected = s.toolsEnabled
        autoApproveCheck.isSelected = s.autoApproveEdits
        debugLogCheck.isSelected = s.debugLogEnabled
        debugLogFolderField.text = s.debugLogFolder
        debugLogRetentionField.text = s.debugLogRetentionDays.toString()
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
        val retention = historyRetentionField.text.trim().toIntOrNull()?.takeIf { it in 0..3650 }
            ?: throw ConfigurationException("History retention must be a whole number of days from 0 to 3650")
        val debugRetention = debugLogRetentionField.text.trim().toIntOrNull()?.takeIf { it in 0..365 }
            ?: throw ConfigurationException("Debug log retention must be a whole number of days from 0 to 365")

        val s = settings.state
        s.ollamaUrl = ollama
        s.aifBaseUrl = aifBase
        s.aifModels = aifModelsArea.text.lines().map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        s.claudeCliPath = claudeCliPathField.text.trim().ifBlank { "claude" }
        s.claudeModels = claudeModelsArea.text.lines().map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        s.toolPathOverrides = overrides.toMutableMap()
        s.autoCompactTokens = autoCompact
        s.historyRetentionDays = retention
        s.toolsEnabled = toolsEnabledCheck.isSelected
        s.autoApproveEdits = autoApproveCheck.isSelected
        s.debugLogEnabled = debugLogCheck.isSelected
        s.debugLogFolder = debugLogFolderField.text.trim().ifBlank { "./log/debug_logs/" }
        s.debugLogRetentionDays = debugRetention
        DebugLogSink.configure(s.debugLogEnabled, s.debugLogFolder.orEmpty(), s.debugLogRetentionDays)

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

private const val UNCHECKED_LOGIN = "Not checked yet"

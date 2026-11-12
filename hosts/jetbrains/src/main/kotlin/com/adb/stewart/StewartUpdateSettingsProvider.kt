package com.adb.stewart

import com.intellij.openapi.updateSettings.impl.UpdateSettingsProvider

internal const val UPDATE_FEED_URL = "https://gdbryant.github.io/Stewart/updatePlugins.xml"

class StewartUpdateSettingsProvider : UpdateSettingsProvider {
    override fun getPluginRepositories(): List<String> = listOf(UPDATE_FEED_URL)
}

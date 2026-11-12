package com.adb.stewart

import org.junit.Assert.assertEquals
import org.junit.Test

class StewartUpdateSettingsProviderTest {
    @Test
    fun contributesTheUpdateFeedUrl() {
        assertEquals(listOf("https://gdbryant.github.io/Stewart/updatePlugins.xml"), StewartUpdateSettingsProvider().pluginRepositories)
    }
}

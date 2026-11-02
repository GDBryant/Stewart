package com.aijb.assistant

import com.aijb.assistant.debug.DebugLogSink
import com.intellij.openapi.application.PathManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Path

class DebugLogSinkIdeTest : BasePlatformTestCase() {

    fun `test relative folder resolves under the ide log directory`() {
        val resolved = DebugLogSink.resolveDirectory("./log/debug_logs/")
        assertTrue(resolved.isAbsolute)
        assertTrue(resolved.startsWith(PathManager.getLogPath()))
        assertEquals("debug_logs", resolved.fileName.toString())
    }

    fun `test absolute folder is unchanged`() {
        val abs = Path.of(System.getProperty("java.io.tmpdir"), "aijb-abs")
        assertEquals(abs, DebugLogSink.resolveDirectory(abs.toString()))
    }
}

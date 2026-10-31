package com.aijb.assistant

import com.aijb.assistant.chat.InitFiles
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InitFilesTest {

    private fun tempDir(): java.nio.file.Path = Files.createTempDirectory("initfiles")

    @Test
    fun `ensure creates both files with parent directories`() {
        val base = tempDir()
        val r = InitFiles.ensure(base)
        assertNull(r.error)
        assertEquals(listOf(InitFiles.AGENTS, InitFiles.MEMORY), r.created)
        assertTrue(r.existing.isEmpty())
        assertTrue(Files.isRegularFile(base.resolve(InitFiles.AGENTS)))
        assertTrue(Files.readString(base.resolve(InitFiles.MEMORY)).isNotBlank())
        assertTrue(r.summary().contains("created"))
    }

    @Test
    fun `ensure leaves existing files untouched`() {
        val base = tempDir()
        Files.writeString(base.resolve(InitFiles.AGENTS), "custom agents")
        val r = InitFiles.ensure(base)
        assertNull(r.error)
        assertEquals(listOf(InitFiles.MEMORY), r.created)
        assertEquals(listOf(InitFiles.AGENTS), r.existing)
        assertEquals("custom agents", Files.readString(base.resolve(InitFiles.AGENTS)))
        assertTrue(r.summary().contains("already present"))
    }

    @Test
    fun `ensure reports error for missing project base`() {
        val r = InitFiles.ensure(null)
        assertEquals("no project directory", r.error)
        assertTrue(r.summary().contains("Init failed"))
    }

    @Test
    fun `ensure reports io failure instead of throwing`() {
        val base = tempDir()
        Files.writeString(base.resolve("docs"), "file blocks dir")
        val r = InitFiles.ensure(base)
        assertEquals(listOf(InitFiles.AGENTS), r.created)
        assertTrue(r.error != null)
    }
}

package com.adb.stewart

import java.awt.Color
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.imageio.ImageIO
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Spike gate for image input: the CLI must accept stream-json stdin with a base64 image block. */
class ClaudeImageLiveTest {

    private fun solidPng(color: Color): String {
        val img = BufferedImage(64, 64, BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.color = color
        g.fillRect(0, 0, 64, 64)
        g.dispose()
        val out = ByteArrayOutputStream()
        ImageIO.write(img, "png", out)
        return Base64.getEncoder().encodeToString(out.toByteArray())
    }

    @Test
    fun `live cli describes a base64 image sent via stream-json stdin`() {
        assumeTrue("CLAUDE_LIVE not set", System.getenv("CLAUDE_LIVE") == "1")
        val line = """{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What single colour is this image? Answer with one word."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${solidPng(Color.RED)}"}}]}}"""
        val pb = ProcessBuilder(
            "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
            "--disable-slash-commands", "--model", System.getenv("CLAUDE_MODEL") ?: "haiku",
        ).redirectErrorStream(true)
        val proc = pb.start()
        proc.outputStream.bufferedWriter().use { it.write(line); it.write("\n") }
        val output = proc.inputStream.bufferedReader().readText()
        assertTrue("CLI timed out", proc.waitFor(120, TimeUnit.SECONDS))
        assertTrue("expected 'red' in reply, got: ${output.take(500)}", output.lowercase().contains("red"))
    }
}

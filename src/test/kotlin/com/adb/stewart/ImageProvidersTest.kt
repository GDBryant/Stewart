package com.adb.stewart

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.chat.redactImages
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.ChatRequest
import com.adb.stewart.debug.DebugLogSink
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.aif.AifHistory
import com.adb.stewart.provider.aif.AifProvider
import com.adb.stewart.provider.claude.ClaudeTranscript
import com.adb.stewart.provider.ollama.OllamaProvider
import com.adb.stewart.shim.RequestTranslator
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageProvidersTest {
    private val img = ImageAttachment("image/png", byteArrayOf(1, 2, 3, 4, 5, 6), "shot.png")
    private val img2 = ImageAttachment("image/jpeg", byteArrayOf(9, 8, 7), "old.jpg")
    private var server: HttpServer? = null
    private var body = ""

    private val b64Run = Regex("[A-Za-z0-9+/=]{100,}")
    private var logDir: java.nio.file.Path? = null
    private var prevEnabled = false
    private var prevDir = ""

    private fun enableLog() {
        prevEnabled = DebugLogSink.isEnabled
        prevDir = DebugLogSink.logDirectory
        logDir = java.nio.file.Files.createTempDirectory("stewart-imglog-")
        DebugLogSink.configure(true, logDir.toString())
    }

    private fun readLog(): String {
        val dir = logDir!!
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            DebugLogSink.flushAndClose()
            val text = java.nio.file.Files.list(dir).use { st ->
                st.toList().joinToString("") { java.nio.file.Files.readString(it) }
            }
            if (text.contains("[outgoing]")) return text
            Thread.sleep(20)
        }
        throw AssertionError("no outgoing log line")
    }

    @After fun tearDown() {
        server?.stop(0)
        logDir?.let {
            DebugLogSink.flushAndClose()
            DebugLogSink.configure(prevEnabled, prevDir)
            it.toFile().deleteRecursively()
        }
    }

    private val bigImg = ImageAttachment("image/png", ByteArray(600) { (it * 31).toByte() }, "big.png")

    private fun assertImageLogged(log: String) {
        assertTrue(log, log.contains("[image png"))
        assertFalse(log, b64Run.containsMatchIn(log))
        assertFalse(log, log.contains(bigImg.base64().take(60)))
    }

    @Test
    fun `ollama debug log has placeholder and no base64`() {
        enableLog()
        ollamaMessages(listOf(ChatMessage(Role.USER, "look", images = listOf(bigImg))))
        assertImageLogged(readLog())
    }

    @Test
    fun `aif debug log has placeholder and no base64`() {
        enableLog()
        aifMessages(listOf(ChatMessage(Role.USER, "look", images = listOf(bigImg))))
        assertImageLogged(readLog())
    }

    @Test
    fun `claude outgoing log text has placeholder and no base64`() {
        enableLog()
        val input = ClaudeTranscript.prepare(listOf(ChatMessage(Role.USER, "look", images = listOf(bigImg))))
        DebugLogSink.log("outgoing", "claude", "m", input.logText())
        assertImageLogged(readLog())
    }

    @Test
    fun `text only messages log their text unchanged`() {
        enableLog()
        ollamaMessages(listOf(ChatMessage(Role.USER, "plain question")))
        val log = readLog()
        assertTrue(log.contains("plain question"))
        assertFalse(log.contains("[image"))
        val input = ClaudeTranscript.prepare(listOf(ChatMessage(Role.USER, "plain question")))
        assertFalse(input.logText().contains("[image"))
        assertTrue(input.logText().contains("plain question"))
    }

    private fun serve(path: String, response: String): Int {
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext(path) { ex ->
            body = ex.requestBody.bufferedReader().readText()
            ex.sendResponseHeaders(200, response.toByteArray().size.toLong())
            ex.responseBody.use { it.write(response.toByteArray()) }
        }
        s.start()
        server = s
        return s.address.port
    }

    private fun ollamaMessages(msgs: List<ChatMessage>) = runBlocking {
        val port = serve("/api/chat", """{"done":true,"done_reason":"stop"}""" + "\n")
        OllamaProvider("http://127.0.0.1:$port").chat(ChatRequest("m", msgs)).collect { }
        Json.parseToJsonElement(body).jsonObject["messages"]!!.jsonArray.map { it.jsonObject }
    }

    private fun aifMessages(msgs: List<ChatMessage>) = runBlocking {
        val port = serve("/v1/chat/completions", "data: [DONE]\n")
        AifProvider("http://127.0.0.1:$port/v1", listOf("m"), { "k" }, java.net.http.HttpClient.newHttpClient())
            .chat(ChatRequest("m", msgs)).collect { }
        Json.parseToJsonElement(body).jsonObject["messages"]!!.jsonArray.map { it.jsonObject }
    }

    @Test
    fun `ollama sends images array`() {
        val m = ollamaMessages(listOf(ChatMessage(Role.USER, "look", images = listOf(img))))[0]
        assertEquals(listOf(img.base64()), m["images"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun `ollama omits images key without images`() {
        assertFalse(ollamaMessages(listOf(ChatMessage(Role.USER, "hi")))[0].containsKey("images"))
    }

    @Test
    fun `aif sends content parts with data url`() {
        val c = aifMessages(listOf(ChatMessage(Role.USER, "look", images = listOf(img))))[0]["content"]!!.jsonArray
        assertEquals("text", c[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("look", c[0].jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("image_url", c[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(img.dataUrl(), c[1].jsonObject["image_url"]!!.jsonObject["url"]!!.jsonPrimitive.content)
    }

    @Test
    fun `aif content stays a plain string without images`() {
        val c = aifMessages(listOf(ChatMessage(Role.USER, "hi")))[0]["content"]!!
        assertEquals("hi", c.jsonPrimitive.content)
    }

    @Test
    fun `aif sanitize preserves images`() {
        val msgs = listOf(
            ChatMessage(Role.USER, "a", images = listOf(img)),
            ChatMessage(Role.TOOL, "orphan", toolCallId = "x"),
        )
        val out = AifHistory.sanitize(msgs)
        assertEquals(listOf(img), out[0].images)
        assertTrue(out[1].images.isEmpty())
    }

    @Test
    fun `shim merge keeps images of both messages`() {
        val merged = RequestTranslator.mergeMessages(listOf(
            ChatMessage(Role.USER, "a", images = listOf(img)),
            ChatMessage(Role.USER, "b", images = listOf(img2)),
        ))
        assertEquals(1, merged.size)
        assertEquals(listOf(img, img2), merged[0].images)
    }

    @Test
    fun `claude argv adds input format only for images`() {
        val plain = ClaudeTranscript.argv("claude", "m", "/p", false)
        val withImg = ClaudeTranscript.argv("claude", "m", "/p", true)
        assertFalse(plain.contains("--input-format"))
        assertEquals(listOf("claude", "-p", "--input-format", "stream-json", "--output-format"), withImg.take(5))
        assertEquals(plain, withImg.filterIndexed { i, _ -> i != 2 && i != 3 })
        assertEquals(listOf("--model", "m", "--system-prompt-file", "/p"), plain.takeLast(4))
    }

    @Test
    fun `claude stream json single line with image block`() {
        val (sys, stdin) = ClaudeTranscript.renderStreamJson(listOf(ChatMessage(Role.USER, "look", images = listOf(img))))
        assertEquals("You are a helpful assistant.", sys)
        assertTrue(stdin.endsWith("\n"))
        assertEquals(1, stdin.trimEnd('\n').lines().size)
        val root = Json.parseToJsonElement(stdin).jsonObject
        assertEquals("user", root["type"]!!.jsonPrimitive.content)
        val msg = root["message"]!!.jsonObject
        assertEquals("user", msg["role"]!!.jsonPrimitive.content)
        val c = msg["content"]!!.jsonArray
        assertEquals("look", c[0].jsonObject["text"]!!.jsonPrimitive.content)
        val src = c[1].jsonObject["source"]!!.jsonObject
        assertEquals("image", c[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("base64", src["type"]!!.jsonPrimitive.content)
        assertEquals("image/png", src["media_type"]!!.jsonPrimitive.content)
        assertEquals(img.base64(), src["data"]!!.jsonPrimitive.content)
    }

    @Test
    fun `claude folds earlier turn images into text and sends only last`() {
        val input = ClaudeTranscript.prepare(listOf(
            ChatMessage(Role.USER, "first", images = listOf(img2)),
            ChatMessage(Role.ASSISTANT, "ok"),
            ChatMessage(Role.USER, "second", images = listOf(img)),
        ))
        assertEquals(listOf(img), input.images)
        assertTrue(input.text.contains("first\n[image: old.jpg]"))
        assertFalse(input.text.contains(img2.base64()))
        assertTrue(input.hasImages)
    }

    @Test
    fun `claude text only prepare matches render and has no images`() {
        val msgs = listOf(ChatMessage(Role.USER, "a"), ChatMessage(Role.ASSISTANT, "b"), ChatMessage(Role.USER, "c"))
        val input = ClaudeTranscript.prepare(msgs)
        assertEquals(ClaudeTranscript.render(msgs).second, input.text)
        assertFalse(input.hasImages)
    }

    @Test
    fun `placeholder and redaction hide base64`() {
        assertEquals("[image png 1KB]", img.placeholder())
        val out = redactImages("x ${img.base64()} y", listOf(img))
        assertEquals("x [image png 1KB] y", out)
        assertEquals("plain", redactImages("plain", emptyList()))
    }

    @Test
    fun `claude later text-only user turn sends no image blocks`() {
        val input = ClaudeTranscript.prepare(listOf(
            ChatMessage(Role.USER, "first", images = listOf(img)),
            ChatMessage(Role.ASSISTANT, "ok"),
            ChatMessage(Role.USER, "second"),
        ))
        assertFalse(input.hasImages)
        assertTrue(input.text.contains("first\n[image: shot.png]"))
        assertFalse(input.text.contains(img.base64()))
    }

    @Test
    fun `claude blank text omits text part`() {
        val c = Json.parseToJsonElement(ClaudeTranscript.renderStreamJson(
            listOf(ChatMessage(Role.USER, "", images = listOf(img))).let { it }).second)
            .jsonObject["message"]!!.jsonObject["content"]!!.jsonArray
        assertEquals(1, c.size)
        assertEquals("image", c[0].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `claude non-blank text part comes first`() {
        val c = Json.parseToJsonElement(ClaudeTranscript.renderStreamJson(
            listOf(ChatMessage(Role.USER, "hey", images = listOf(img)))).second)
            .jsonObject["message"]!!.jsonObject["content"]!!.jsonArray
        assertEquals("text", c[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(2, c.size)
    }

    @Test
    fun `aif blank text omits text part`() {
        val c = aifMessages(listOf(ChatMessage(Role.USER, "  ", images = listOf(img))))[0]["content"]!!.jsonArray
        assertEquals(1, c.size)
        assertEquals("image_url", c[0].jsonObject["type"]!!.jsonPrimitive.content)
    }
}

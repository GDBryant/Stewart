package com.aijb.assistant

import com.aijb.assistant.http.IdeHttpClients
import com.aijb.assistant.http.LoopbackDirectProxySelector
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IdeHttpClientsTest {

    private class RecordingSelector(
        private val result: List<Proxy> = listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("proxy.local", 3128))),
    ) : ProxySelector() {
        val selected = mutableListOf<String?>()
        val failures = mutableListOf<String>()

        override fun select(uri: URI): List<Proxy> {
            selected += uri.host
            return result
        }

        override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {
            failures += uri.toString()
        }
    }

    @Test
    fun `loopback hosts bypass the configured proxy`() {
        val delegate = RecordingSelector()
        val selector = LoopbackDirectProxySelector(delegate)
        listOf("localhost", "127.0.0.1", "[::1]", "LocalHost").forEach { host ->
            assertEquals(listOf(Proxy.NO_PROXY), selector.select(URI("http://$host:11434/api/chat")))
        }
        listOf("localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1").forEach {
            assertTrue("$it must be loopback", LoopbackDirectProxySelector.isLoopback(it))
        }
        assertFalse(LoopbackDirectProxySelector.isLoopback("aif.example.com"))
        assertFalse(LoopbackDirectProxySelector.isLoopback(null))
        assertTrue("delegate must not be consulted for loopback", delegate.selected.isEmpty())
    }

    @Test
    fun `remote hosts use the configured proxy`() {
        val delegate = RecordingSelector()
        val selector = LoopbackDirectProxySelector(delegate)
        val proxies = selector.select(URI("https://aif.example.com/v1/chat/completions"))
        assertEquals(listOf("aif.example.com"), delegate.selected)
        assertEquals(1, proxies.size)
        assertFalse(proxies.first() == Proxy.NO_PROXY)
        assertEquals(InetSocketAddress("proxy.local", 3128), proxies.first().address())
    }

    @Test
    fun `connect failed is forwarded to the configured selector`() {
        val delegate = RecordingSelector()
        val selector = LoopbackDirectProxySelector(delegate)
        selector.connectFailed(
            URI("https://aif.example.com"), InetSocketAddress("proxy.local", 3128), IOException("refused"))
        assertEquals(listOf("https://aif.example.com"), delegate.failures)
    }

    @Test
    fun `create works without an application and keeps loopback direct`() {
        val client = IdeHttpClients.create()
        assertNotNull(client)
        val selector = client.proxy().orElse(null)
        assertNotNull("client must carry a proxy selector", selector)
        assertTrue(selector is LoopbackDirectProxySelector)
        assertEquals(listOf(Proxy.NO_PROXY), selector.select(URI("http://127.0.0.1:11434/api/tags")))
    }
}

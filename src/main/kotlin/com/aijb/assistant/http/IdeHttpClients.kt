package com.aijb.assistant.http

import com.intellij.openapi.application.ApplicationManager
import com.intellij.util.net.JdkProxyProvider
import com.intellij.util.net.ssl.CertificateManager
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.time.Duration

/**
 * Loopback hosts never go through the configured proxy: a local Ollama or AIF endpoint would
 * otherwise fail as soon as a corporate proxy is set.
 */
class LoopbackDirectProxySelector(private val delegate: ProxySelector) : ProxySelector() {
    override fun select(uri: URI): List<Proxy> =
        if (isLoopback(uri.host)) listOf(Proxy.NO_PROXY) else delegate.select(uri)

    override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) =
        delegate.connectFailed(uri, sa, ioe)

    companion object {
        fun isLoopback(host: String?): Boolean = when (host?.lowercase()) {
            null -> false
            "localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1" -> true
            else -> false
        }
    }
}

private object DirectProxySelector : ProxySelector() {
    override fun select(uri: URI): List<Proxy> = listOf(Proxy.NO_PROXY)
    override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {}
}

object IdeHttpClients {
    fun create(): HttpClient {
        val builder = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
        if (ApplicationManager.getApplication() == null) {
            return builder
                .proxy(LoopbackDirectProxySelector(ProxySelector.getDefault() ?: DirectProxySelector))
                .build()
        }
        val proxy = JdkProxyProvider.getInstance()
        return builder
            .proxy(LoopbackDirectProxySelector(proxy.proxySelector))
            .authenticator(proxy.authenticator)
            .sslContext(CertificateManager.getInstance().sslContext)
            .build()
    }
}

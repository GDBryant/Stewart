package com.aijb.assistant.http

import com.intellij.util.net.JdkProxyProvider
import com.intellij.util.net.ssl.CertificateManager
import java.net.http.HttpClient
import java.time.Duration

object IdeHttpClients {
    fun create(): HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .proxy(JdkProxyProvider.getInstance().proxySelector)
        .authenticator(JdkProxyProvider.getInstance().authenticator)
        .sslContext(CertificateManager.getInstance().sslContext)
        .build()
}

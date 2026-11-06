package com.adb.stewart

import com.adb.stewart.host.HostRequestHandler
import com.adb.stewart.rpc.Link
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

/**
 * The attach handshake over a live sidecar link: host.* request routing,
 * proc/log notification fan-out, config dir announcements and project.attach.
 * Extracted from the project service so it can be tested against a link pair.
 */
object SidecarWiring {
    const val PROTOCOL = 1
    private val LOG = Logger.getInstance(SidecarWiring::class.java)

    fun attach(
        link: Link,
        hostHandler: HostRequestHandler,
        projectId: String,
        userConfigDir: File,
        projectConfigDir: File,
        pushInbound: (JsonObject) -> Unit,
        onLog: (String) -> Unit = { LOG.info(it) },
        debugLogDir: File? = null,
    ) {
        link.onRequest { method, params -> hostHandler.handler(method, params) }
        link.onNotification { method, params ->
            when (method) {
                "proc.write", "proc.cancel", "log" -> hostHandler.notifyHandler(method, params)
                "event" -> pushInbound(JsonObject(mapOf("type" to JsonPrimitive("event"), "ev" to (params ?: JsonPrimitive("")))))
                "protocol.error" -> LOG.warn("sidecar protocol error: $params")
            }
        }
        link.notify("config.dir", buildJsonObject { put("dir", JsonPrimitive(userConfigDir.absolutePath)) })
        link.notify("config.projectDir", buildJsonObject { put("dir", JsonPrimitive(projectConfigDir.absolutePath)) })
        debugLogDir?.let { link.notify("log.dir", buildJsonObject { put("dir", JsonPrimitive(it.absolutePath)) }) }
        link.request(
            "project.attach",
            buildJsonObject {
                put("projectId", JsonPrimitive(projectId))
                put("protocol", JsonPrimitive(PROTOCOL))
                put("userConfigDir", JsonPrimitive(userConfigDir.absolutePath))
            },
        ).whenComplete { r, e ->
            if (e != null) LOG.warn("project.attach failed: ${e.message}") else LOG.info("stewart sidecar attached: $r")
        }
    }
}

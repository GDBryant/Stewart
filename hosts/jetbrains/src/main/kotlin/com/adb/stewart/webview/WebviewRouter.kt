package com.adb.stewart.webview

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.util.concurrent.CompletableFuture

/**
 * Webview↔sidecar message routing, mirroring hosts/vscode/src/extension.ts
 * `route()`: each outbound `type` maps to a core dispatch, a few get shaped
 * replies (config/test/probe) and `skills.open` opens the file in the editor.
 */
class WebviewRouter(
    private val projectId: () -> String,
    private val request: (String, JsonObject?) -> CompletableFuture<JsonElement?>,
    private val send: (JsonObject) -> Unit,
    private val userConfigDir: () -> File,
    private val openInEditor: (File) -> Unit = {},
    private val pickV1Xml: () -> String? = { null },
    private val insertIntoEditor: (String) -> Unit = {},
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val routeLock = Any()

    fun route(raw: String) {
        val m = try {
            json.parseToJsonElement(raw) as? JsonObject
        } catch (e: Exception) {
            null
        }
        if (m == null) {
            send(errorMsg("malformed message"))
            return
        }
        val type = (m["type"] as? JsonPrimitive)?.content ?: run {
            send(errorMsg("missing type"))
            return
        }
        try {
            synchronized(routeLock) {
            when (type) {
                "ready" -> {
                    request("hello", buildJsonObject {
                        put("protocol", JsonPrimitive(1))
                        put("capabilities", Json.parseToJsonElement("""["stream_events","approvals","diff_preview","diagnostics","images"]"""))
                    }).get()
                    send(JsonObject(mapOf("type" to JsonPrimitive("ready"))))
                }
                "config.get" -> {
                    val r = request("config.get", withProject()).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("config"))))
                }
                "config.set" -> {
                    request("config.set", withProject(m)).get()
                    val r = request("config.get", withProject()).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("config"))))
                }
                "setup.recommend" -> {
                    val r = request("setup.recommend", withProject(m)).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("setup.recommend.result"))))
                }
                "channel.test" -> {
                    val r = request("channel.test", withProject(m)).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("channel.test.result")) + ("channelId" to (m["channelId"] ?: JsonPrimitive("")))))
                }
                "channel.probe" -> {
                    val r = request("channel.probe", withProject(m)).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("channel.probe.result")) + ("channelId" to (m["channelId"] ?: JsonPrimitive(""))) + ("model" to (m["model"] ?: JsonPrimitive("")))))
                }
                "history.list" -> {
                    val r = request("history.list", withProject()).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("history.sessions"))))
                }
                "history.load" -> {
                    val r = request("history.load", withProject(m)).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("history.messages")) + ("sessionId" to (m["sessionId"] ?: JsonPrimitive("")))))
                }
                "history.delete" -> {
                    request("history.delete", withProject(m)).get()
                    val r = request("history.list", withProject()).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("history.sessions"))))
                }
                "config.importV1" -> {
                    val applied = (m["apply"] as? JsonPrimitive)?.content == "true"
                    val r = request("config.importV1", withProject(m)).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(
                        JsonObject(
                            r +
                                ("type" to JsonPrimitive("v1.draft")) +
                                ("xml" to (m["xml"] ?: JsonPrimitive(""))) +
                                ("applied" to JsonPrimitive(applied)),
                        ),
                    )
                }
                "v1.import" -> {
                    val xml = pickV1Xml() ?: return
                    val r = request(
                        "config.importV1",
                        withProject(buildJsonObject { put("xml", JsonPrimitive(xml)) }),
                    ).get()?.jsonObject ?: JsonObject(emptyMap())
                    send(JsonObject(r + ("type" to JsonPrimitive("v1.draft")) + ("xml" to JsonPrimitive(xml))))
                }
                "editor.insert" -> {
                    insertIntoEditor(m["text"]?.jsonPrimitive?.content ?: throw IllegalArgumentException("missing text"))
                }
                "skills.open" -> openSkill(m["id"]?.jsonPrimitive?.content ?: throw IllegalArgumentException("missing skill id"))
                else -> {
                    request(type, withProject(m)).get()
                }
            }
            }
        } catch (e: Throwable) {
            send(errorMsg(e.cause?.message ?: e.message ?: "error"))
        }
    }

    private fun withProject(m: JsonObject = JsonObject(emptyMap())): JsonObject =
        JsonObject(m.filterKeys { it != "type" } + ("projectId" to JsonPrimitive(projectId())))

    private fun errorMsg(message: String) = JsonObject(mapOf("type" to JsonPrimitive("error"), "message" to JsonPrimitive(message)))

    private fun openSkill(id: String) {
        val file = File(File(userConfigDir(), "skills"), "$id.md")
        if (!file.exists()) {
            val r = request("config.get", withProject()).get()?.jsonObject
            val skills = ((r?.get("summary") as? JsonObject)?.get("skills") as? kotlinx.serialization.json.JsonArray)
            val s = skills?.map { it.jsonObject }?.find { it["id"]?.jsonPrimitive?.content == id }
                ?: throw IllegalArgumentException("unknown skill: $id")
            request(
                "skills.save",
                withProject(
                    buildJsonObject {
                        put("id", JsonPrimitive(id))
                        put("body", s["body"] ?: JsonPrimitive(""))
                        put("description", s["description"] ?: JsonPrimitive(""))
                    },
                ),
            ).get()
        }
        openInEditor(file)
    }
}

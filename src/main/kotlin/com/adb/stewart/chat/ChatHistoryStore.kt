package com.adb.stewart.chat

import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import com.adb.stewart.provider.ToolCall
import com.adb.stewart.provider.Usage
import com.adb.stewart.settings.LegacyMigration
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.FileTime
import java.util.concurrent.TimeUnit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

@Serializable
internal data class StoredToolCall(val id: String, val name: String, val arguments: JsonObject)

@Serializable
internal data class StoredMessage(
    val role: String,
    val content: String,
    val toolCalls: List<StoredToolCall> = emptyList(),
    val toolCallId: String? = null,
)

@Serializable
internal data class StoredChat(
    val version: Int,
    val savedAt: Long,
    val messages: List<StoredMessage>,
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
    val costUsd: Double? = null,
)

data class LoadedChat(val messages: List<ChatMessage>, val usage: Usage?, val savedAt: Long)

/**
 * Per-project chat history as one JSON file in the plugin state directory (never `.idea/`).
 * Writes are atomic; an unreadable or unknown-version file is set aside as `.corrupt` and never throws.
 * System messages are never persisted (role prompts are injected per request).
 */
open class ChatHistoryStore(val file: Path) {

    private val lock = Any()

    open fun save(messages: List<ChatMessage>, usage: Usage?, now: Long = System.currentTimeMillis()) {
        val stored = messages.filter { it.role != Role.SYSTEM }
        if (stored.isEmpty()) {
            delete()
            return
        }
        val chat = StoredChat(
            VERSION, now,
            stored.map { m ->
                StoredMessage(
                    m.role.name, m.content,
                    m.toolCalls.map { StoredToolCall(it.id, it.name, it.arguments) },
                    m.toolCallId,
                )
            },
            usage?.promptTokens, usage?.completionTokens, usage?.costUsd,
        )
        synchronized(lock) {
            Files.createDirectories(file.parent)
            val tmp = file.resolveSibling(file.fileName.toString() + ".tmp")
            Files.writeString(tmp, JSON.encodeToString(StoredChat.serializer(), chat))
            try {
                Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
            }
        }
    }

    /** Returns the stored chat, or null when absent, expired (`retentionDays`), disabled (<= 0) or unreadable. */
    open fun load(retentionDays: Int, now: Long = System.currentTimeMillis()): LoadedChat? = synchronized(lock) {
        if (!Files.exists(file)) return null
        if (retentionDays <= 0) {
            delete()
            return null
        }
        val chat = try {
            JSON.decodeFromString(StoredChat.serializer(), Files.readString(file))
        } catch (e: Exception) {
            quarantine()
            return null
        }
        if (chat.version != VERSION) {
            quarantine()
            return null
        }
        if (now - chat.savedAt > TimeUnit.DAYS.toMillis(retentionDays.toLong())) {
            delete()
            return null
        }
        val messages = try {
            chat.messages.map { m ->
                ChatMessage(
                    Role.valueOf(m.role), m.content,
                    m.toolCalls.map { ToolCall(it.id, it.name, it.arguments) },
                    m.toolCallId,
                )
            }
        } catch (e: IllegalArgumentException) {
            quarantine()
            return null
        }
        val usage = if (chat.promptTokens == null && chat.completionTokens == null && chat.costUsd == null) {
            null
        } else {
            Usage(chat.promptTokens, chat.completionTokens, chat.costUsd)
        }
        LoadedChat(messages, usage, chat.savedAt)
    }

    open fun delete() {
        synchronized(lock) {
            Files.deleteIfExists(file)
            Files.deleteIfExists(file.resolveSibling(file.fileName.toString() + ".tmp"))
        }
    }

    private fun quarantine() {
        try {
            Files.move(
                file, file.resolveSibling(file.fileName.toString() + ".corrupt"),
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (e: java.io.IOException) {
            Files.deleteIfExists(file)
        }
    }

    companion object {
        const val VERSION = 1

        fun pathFor(systemDir: Path, projectHash: String): Path =
            historyDir(systemDir).resolve("$projectHash.json")

        fun historyDir(systemDir: Path): Path = systemDir.resolve("stewart").resolve("history")

        /** Copies the pre-rename history dir once, when the new one does not exist yet; true if it copied. */
        fun migrateLegacy(systemDir: Path): Boolean = LegacyMigration.copyDir(
            systemDir.resolve(LegacyMigration.HISTORY_DIR).resolve("history"), historyDir(systemDir),
        )
        private val JSON = Json { ignoreUnknownKeys = false }

        /** Deletes history files in [dir] (any project) not modified within [retentionDays]. */
        fun pruneExpired(dir: Path, retentionDays: Int, now: Long = System.currentTimeMillis()) {
            if (!Files.isDirectory(dir)) return
            val cutoff = FileTime.fromMillis(now - TimeUnit.DAYS.toMillis(retentionDays.coerceAtLeast(0).toLong()))
            Files.list(dir).use { stream ->
                stream.filter { it.fileName.toString().endsWith(".json") }
                    .filter { Files.getLastModifiedTime(it) < cutoff }
                    .toList()
            }.forEach { Files.deleteIfExists(it) }
        }
    }
}

package com.adb.stewart.chat

import java.nio.file.Files
import java.nio.file.Path

/** Creates the `/init` starter files (AGENTS.md, docs/ai_docs/MEMORY.md) that do not exist yet. */
object InitFiles {

    const val AGENTS = "AGENTS.md"
    const val MEMORY = "docs/ai_docs/MEMORY.md"

    private const val AGENTS_STUB = "# AGENTS\n\nNotes for AI assistants. To be filled in by /init.\n"
    private const val MEMORY_STUB = "# Project memory\n\nDurable project facts confirmed by AI sessions.\n"

    data class Result(
        val created: List<String>,
        val existing: List<String>,
        val error: String? = null,
    ) {
        fun summary(): String = when {
            error != null -> "Init failed: $error"
            created.isEmpty() && existing.isEmpty() -> "Init: nothing found"
            else -> buildString {
                if (created.isNotEmpty()) append("created: ${created.joinToString(", ")}")
                if (existing.isNotEmpty()) {
                    if (isNotEmpty()) append(" · ")
                    append("already present: ${existing.joinToString(", ")}")
                }
            }
        }
    }

    fun ensure(base: Path?): Result {
        if (base == null) return Result(emptyList(), emptyList(), "no project directory")
        val created = mutableListOf<String>()
        val existing = mutableListOf<String>()
        return try {
            for ((rel, stub) in listOf(AGENTS to AGENTS_STUB, MEMORY to MEMORY_STUB)) {
                val target = base.resolve(rel)
                if (Files.isRegularFile(target)) {
                    existing.add(rel)
                } else {
                    target.parent?.let { Files.createDirectories(it) }
                    Files.writeString(target, stub)
                    created.add(rel)
                }
            }
            Result(created, existing)
        } catch (e: Exception) {
            Result(created, existing, e.message ?: "write failed")
        }
    }
}

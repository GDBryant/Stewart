package com.adb.stewart.host

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.ide.trustedProjects.TrustedProjectsLocator
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.IOException
import java.util.concurrent.CompletableFuture

/**
 * Serves `host.*` requests coming from the sidecar: secrets, versioned file
 * edits, processes, diff preview, diagnostics and workspace info.
 */
class HostRequestHandler(
    private val project: Project,
    private val files: WorkspaceFiles = WorkspaceFiles(project),
    private val secrets: SecretStore = SecretStore(),
    private val diagnostics: Diagnostics = Diagnostics(project),
    private val procs: ProcessRegistry,
    private val stateDir: File = File(PathManager.getConfigPath(), "stewart/${project.locationHash}"),
) {
    companion object {
        private val LOG = Logger.getInstance(HostRequestHandler::class.java)
    }

    private fun str(params: JsonElement?, key: String): String =
        params?.jsonObject?.get(key)?.jsonPrimitive?.content ?: throw IOException("$key required")

    private fun strOrNull(params: JsonElement?, key: String): String? = params?.jsonObject?.get(key)?.jsonPrimitive?.content

    fun handler(method: String, params: JsonElement?): CompletableFuture<JsonElement?> =
        CompletableFuture<JsonElement?>().also { fut ->
            if (ApplicationManager.getApplication().isDispatchThread) {
                try {
                    fut.complete(handle(method, params))
                } catch (e: Throwable) {
                    fut.completeExceptionally(e)
                }
                return@also
            }
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    fut.complete(handle(method, params))
                } catch (e: Throwable) {
                    fut.completeExceptionally(e)
                }
            }
        }

    private fun handle(method: String, params: JsonElement?): JsonElement? = when (method) {
        "host.secrets.get" -> secrets.get(str(params, "ref"))?.let { JsonPrimitive(it) } ?: JsonNull
        "host.secrets.set" -> {
            secrets.set(str(params, "ref"), str(params, "value"))
            JsonObject(emptyMap())
        }
        "host.secrets.delete" -> {
            secrets.delete(str(params, "ref"))
            JsonObject(emptyMap())
        }
        "host.files.read" -> files.read(str(params, "path"))
        "host.files.edit" -> files.edit(params?.jsonObject ?: throw IOException("edit required"))
        "host.files.readBack" -> files.readBack(str(params, "path"))
        "host.files.exists" -> files.exists(str(params, "path"))
        "host.files.list" -> files.list(str(params, "dir"))
        "host.files.stat" -> files.stat(str(params, "path"))
        "host.files.writeAtomic" -> files.writeAtomic(str(params, "path"), str(params, "content"))
        "host.files.appendLine" -> files.appendLine(str(params, "path"), str(params, "line"))
        "host.files.readLines" -> files.readLines(str(params, "path"))
        "host.files.delete" -> files.delete(str(params, "path"))
        "host.proc.run" -> {
            val o = params?.jsonObject ?: throw IOException("params required")
            val argv = o["argv"]?.jsonArray?.map { it.jsonPrimitive.content } ?: throw IOException("argv required")
            val env = o["env"]?.jsonObject?.entries?.associate { it.key to it.value.jsonPrimitive.content }
            procs.run(str(o, "handle"), argv, strOrNull(o, "cwd"), env)
        }
        "host.proc.killTree" -> {
            procs.killTree(str(params, "handle"))
            JsonObject(emptyMap())
        }
        "host.diff.preview" -> {
            diffPreview(str(params, "path"), str(params, "next"))
            JsonObject(emptyMap())
        }
        "host.diag.problems" -> diagnostics.problems(strOrNull(params, "path"))
        "host.workspace.roots" -> JsonArray(listOfNotNull(project.basePath).map { JsonPrimitive(it) })
        "host.workspace.stateDir" -> JsonPrimitive(stateDir.absolutePath)
        "host.workspace.trusted" -> JsonPrimitive(TrustedProjects.isProjectTrusted(TrustedProjectsLocator.locateProject(project)))
        else -> throw IOException("unknown host method: $method")
    }

    /** Sidecar→host notifications: process stdin/cancel and log lines. */
    fun notifyHandler(method: String, params: JsonElement?) {
        when (method) {
            "proc.write" -> procs.write(str(params, "handle"), str(params, "data"))
            "proc.cancel" -> procs.cancel(str(params, "handle"))
            "log" -> LOG.info(strOrNull(params, "line") ?: params.toString())
        }
    }

    private fun diffPreview(path: String, next: String) {
        ApplicationManager.getApplication().invokeLater {
            try {
                val base = project.basePath ?: return@invokeLater
                val vf = LocalFileSystem.getInstance().findFileByIoFile(File(base, path))
                val factory = DiffContentFactory.getInstance()
                val old = vf?.let { factory.create(project, it) } ?: factory.create(project, "")
                val new = factory.create(project, next)
                DiffManager.getInstance().showDiff(project, SimpleDiffRequest("Stewart: $path", old, new, "Current", "Proposed"))
            } catch (t: Throwable) {
                LOG.warn("diff preview failed for $path: ${t.message}")
            }
        }
    }

    fun dispose() {
        procs.killAll()
    }
}

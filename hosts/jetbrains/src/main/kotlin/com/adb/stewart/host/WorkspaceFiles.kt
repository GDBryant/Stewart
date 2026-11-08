package com.adb.stewart.host

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * HostPort file surface: paths that are absolute (config/state files) are used
 * as-is; relative paths resolve under the project base directory. Edits go
 * through WriteCommandAction so they join native undo; document modification
 * stamps play the role of VS Code's document.version.
 */
class WorkspaceFiles(private val project: Project) {

    fun resolve(path: String): File {
        val f = File(path)
        if (f.isAbsolute) return f
        val base = project.basePath ?: throw IOException("project has no base directory")
        return File(base, path)
    }

    private fun virtualFile(path: String): VirtualFile {
        val f = resolve(path)
        return LocalFileSystem.getInstance().refreshAndFindFileByIoFile(f)
            ?: throw IOException("file not found: $path")
    }

    private fun documentFor(path: String, vf: VirtualFile): Document =
        FileDocumentManager.getInstance().getDocument(vf)
            ?: throw IOException("no document for $path")

    private fun <T> onEdt(f: () -> T): T {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) return f()
        val ref = java.util.concurrent.atomic.AtomicReference<T>()
        app.invokeAndWait { ref.set(f()) }
        return ref.get()
    }

    /**
     * Unsaved editor edits win; otherwise read disk directly. The VFS/Document cache
     * lags behind java.io writes (writeAtomic), so trusting it returns stale text.
     */
    private fun currentText(vf: VirtualFile, doc: Document?): String {
        if (doc != null && FileDocumentManager.getInstance().isDocumentUnsaved(doc)) return doc.text
        val f = File(vf.path)
        return if (f.isFile) f.readText(Charsets.UTF_8) else doc?.text ?: VfsUtil.loadText(vf)
    }

    fun read(path: String): JsonObject {
        val vf = virtualFile(path)
        return ApplicationManager.getApplication().runReadAction(Computable {
            val doc = FileDocumentManager.getInstance().getDocument(vf)
            val content = currentText(vf, doc)
            buildJsonObject {
                put("content", JsonPrimitive(content))
                if (doc != null) put("version", JsonPrimitive(doc.modificationStamp))
            }
        })
    }

    fun edit(edit: JsonObject): JsonObject {
        val path = edit["path"]?.jsonPrimitive?.content ?: throw IOException("files.edit: missing path")
        val vf = virtualFile(path)
        return onEdt {
            val doc = documentFor(path, vf)
            val base = edit["baseVersion"]?.jsonPrimitive?.longOrNull
            if (base != null && doc.modificationStamp != base) {
                throw IOException("stale preview for $path: expected v$base, doc is v${doc.modificationStamp}")
            }
            WriteCommandAction.runWriteCommandAction(project) {
                val content = edit["content"]?.jsonPrimitive?.content
                if (content != null) {
                    doc.setText(content)
                } else {
                    for (e in edit["edits"]?.jsonArray ?: emptyList()) {
                        val o = e.jsonObject
                        val oldText = o["oldText"]?.jsonPrimitive?.content ?: throw IOException("files.edit: missing oldText")
                        val newText = o["newText"]?.jsonPrimitive?.content ?: ""
                        val idx = doc.text.indexOf(oldText)
                        if (idx < 0) throw IOException("anchor not found in $path")
                        doc.replaceString(idx, idx + oldText.length, newText)
                    }
                }
            }
            FileDocumentManager.getInstance().saveDocument(doc)
            buildJsonObject {
                put("applied", JsonPrimitive(true))
                put("version", JsonPrimitive(doc.modificationStamp))
            }
        }
    }

    fun readBack(path: String): JsonElement {
        val vf = virtualFile(path)
        return ApplicationManager.getApplication().runReadAction(Computable {
            JsonPrimitive(currentText(vf, FileDocumentManager.getInstance().getDocument(vf)))
        })
    }

    fun exists(path: String): JsonElement = JsonPrimitive(resolve(path).exists())

    fun list(dir: String): JsonArray {
        val root = resolve(dir.ifBlank { "." })
        val out = mutableListOf<JsonElement>()
        fun walk(f: File, rel: String) {
            val children = f.listFiles() ?: return
            for (c in children.sortedBy { it.name }) {
                if (c.name.startsWith(".") || c.name == "node_modules") continue
                val r = if (rel.isEmpty()) c.name else "$rel/${c.name}"
                if (c.isDirectory) walk(c, r) else if (c.isFile) out.add(JsonPrimitive(r))
                if (out.size >= 20_000) return
            }
        }
        walk(root, if (dir.isBlank() || dir == ".") "" else dir.trimEnd('/'))
        return JsonArray(out)
    }

    fun stat(path: String): JsonObject {
        val f = resolve(path)
        if (!f.isFile) throw IOException("not a file: $path")
        return JsonObject(mapOf("size" to JsonPrimitive(f.length())))
    }

    fun readBinary(path: String): JsonObject {
        val f = resolve(path)
        if (!f.isFile) throw IOException("not a file: $path")
        val bytes = f.readBytes()
        return buildJsonObject {
            put("base64", JsonPrimitive(java.util.Base64.getEncoder().encodeToString(bytes)))
            put("size", JsonPrimitive(bytes.size))
        }
    }

    fun writeBinary(path: String, base64: String): JsonElement {
        val f = resolve(path)
        f.parentFile?.mkdirs()
        f.writeBytes(java.util.Base64.getDecoder().decode(base64))
        return JsonObject(emptyMap())
    }

    fun writeAtomic(path: String, content: String): JsonElement {
        val target = resolve(path)
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, "${target.name}.tmp-${System.currentTimeMillis()}")
        tmp.writeText(content, Charsets.UTF_8)
        if (target.exists() && !target.delete()) {
            tmp.delete()
            throw IOException("cannot replace $path")
        }
        if (!tmp.renameTo(target)) {
            tmp.delete()
            throw IOException("cannot move temp file to $path")
        }
        LocalFileSystem.getInstance().refreshIoFiles(listOf(target), true, false, null)
        return JsonObject(emptyMap())
    }

    fun appendLine(path: String, line: String): JsonElement {
        val f = resolve(path)
        f.parentFile?.mkdirs()
        FileOutputStream(f, true).use { out ->
            out.write("$line\n".toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        return JsonObject(emptyMap())
    }

    fun readLines(path: String): JsonArray {
        val f = resolve(path)
        if (!f.isFile) return JsonArray(emptyList())
        return JsonArray(f.readLines(Charsets.UTF_8).filter { it.isNotEmpty() }.map { JsonPrimitive(it) })
    }

    fun delete(path: String): JsonElement {
        resolve(path).delete()
        return JsonObject(emptyMap())
    }
}

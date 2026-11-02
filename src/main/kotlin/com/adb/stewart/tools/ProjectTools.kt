package com.adb.stewart.tools

import com.adb.stewart.provider.ToolSpec
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.runReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import java.nio.charset.StandardCharsets
import java.nio.file.FileSystems
import java.nio.file.Path
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

private fun args(obj: JsonObject, key: String): String =
    obj[key]?.jsonPrimitive?.content ?: throw IllegalArgumentException("missing '$key'")

private fun optInt(obj: JsonObject, key: String): Int? = obj[key]?.jsonPrimitive?.intOrNull

private fun optBool(obj: JsonObject, key: String): Boolean = obj[key]?.jsonPrimitive?.booleanOrNull == true

private fun schema(props: Map<String, JsonObject>, required: List<String>): JsonObject = buildJsonObject {
    put("type", "object")
    putJsonObject("properties") { props.forEach { (k, v) -> put(k, v) } }
    put("required", kotlinx.serialization.json.JsonArray(required.map { JsonPrimitive(it) }))
    put("additionalProperties", JsonPrimitive(false))
}

private fun str(): JsonObject = JsonObject(mapOf("type" to JsonPrimitive("string")))
private fun int(): JsonObject = JsonObject(mapOf("type" to JsonPrimitive("integer")))
private fun bool(): JsonObject = JsonObject(mapOf("type" to JsonPrimitive("boolean")))

private const val MAX_SEARCH_RESULTS = 200
private const val MAX_FIND_RESULTS = 500
private const val MAX_FILE_BYTES = 1_000_000
private const val MAX_COMMAND_OUTPUT = 200_000

private fun isBinary(bytes: ByteArray): Boolean =
    bytes.take(8192).any { it.toInt() == 0 }

abstract class ProjectTool(
    protected val project: Project,
    protected val paths: ProjectPaths,
) : Tool

class ReadFile(project: Project, paths: ProjectPaths) : ProjectTool(project, paths) {
    override val spec = ToolSpec("ReadFile", "Read a project file",
        schema(mapOf(
            "path" to str(), "start_line" to int(), "end_line" to int()),
            listOf("path")))
    override val requiresApproval = false

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val p = paths.resolve(args(arguments, "path"))
        val rel = paths.relative(p)
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(p.toString())
            ?: throw IllegalArgumentException("file not found: $rel")
        if (vf.isDirectory) throw IllegalArgumentException("not a file: $rel")
        if (vf.length > MAX_FILE_BYTES) throw IllegalArgumentException("file too large: $rel")
        val bytes = runReadAction<ByteArray> { vf.contentsToByteArray() }
        if (isBinary(bytes)) throw IllegalArgumentException("binary file: $rel")
        val doc = FileDocumentManager.getInstance().getCachedDocument(vf)
        val text = doc?.text ?: String(bytes, vf.charset)
        val lines = text.lines()
        val start = optInt(arguments, "start_line") ?: 1
        val end = optInt(arguments, "end_line") ?: lines.size
        if (start < 1 || end < start || start > lines.size) {
            throw IllegalArgumentException("invalid line range $start-$end (file has ${lines.size} lines)")
        }
        return lines.subList(start - 1, minOf(end, lines.size))
            .mapIndexed { i, l -> "${start + i}: $l" }.joinToString("\n")
    }
}

class FindFiles(project: Project, paths: ProjectPaths) : ProjectTool(project, paths) {
    override val spec = ToolSpec("FindFiles", "Find project files matching a glob",
        schema(mapOf("glob" to str(), "path" to str()), listOf("glob")))
    override val requiresApproval = false

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val matcher = try {
            FileSystems.getDefault().getPathMatcher("glob:" + args(arguments, "glob"))
        } catch (e: Exception) {
            throw IllegalArgumentException("invalid glob: ${e.message}")
        }
        val root = arguments["path"]?.let { paths.resolve(it.jsonPrimitive.content) } ?: paths.base
        val startVf = LocalFileSystem.getInstance().refreshAndFindFileByPath(root.toString())
            ?: throw IllegalArgumentException("file not found: " + paths.relative(root))
        if (startVf.isDirectory) VfsUtil.markDirtyAndRefresh(false, true, true, startVf)
        val results = mutableListOf<String>()
        var overflow = 0
        val index = ProjectFileIndex.getInstance(project)
        runReadAction<Boolean> {
            index.iterateContentUnderDirectory(startVf) { vf ->
                if (!vf.isDirectory) {
                    val real = runCatching { paths.resolve(vf.path) }.getOrNull()
                    if (real != null) {
                        val rel = paths.relative(real)
                        if (matcher.matches(Path.of(rel))) {
                            if (results.size < MAX_FIND_RESULTS) results.add(rel) else overflow++
                        }
                    }
                }
                true
            }
        }
        if (overflow > 0) results.add("[$overflow more]")
        return if (results.isEmpty()) "no files matched" else results.joinToString("\n")
    }
}

class Search(project: Project, paths: ProjectPaths) : ProjectTool(project, paths) {
    override val spec = ToolSpec("Search", "Search file contents in the project",
        schema(mapOf(
            "query" to str(), "regex" to bool(), "path" to str(), "max_results" to int()),
            listOf("query")))
    override val requiresApproval = false

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val query = args(arguments, "query")
        val regex = if (optBool(arguments, "regex")) {
            try {
                Regex(query)
            } catch (e: Exception) {
                throw IllegalArgumentException("invalid regex: ${e.message}")
            }
        } else null
        val root = arguments["path"]?.let { paths.resolve(it.jsonPrimitive.content) } ?: paths.base
        val startVf = LocalFileSystem.getInstance().refreshAndFindFileByPath(root.toString())
            ?: throw IllegalArgumentException("file not found: " + paths.relative(root))
        if (startVf.isDirectory) VfsUtil.markDirtyAndRefresh(false, true, true, startVf)
        val max = (optInt(arguments, "max_results") ?: MAX_SEARCH_RESULTS)
            .coerceIn(1, MAX_SEARCH_RESULTS)
        val results = mutableListOf<String>()
        var overflow = 0
        val index = ProjectFileIndex.getInstance(project)
        runReadAction<Boolean> {
            index.iterateContentUnderDirectory(startVf) { vf ->
                val real = runCatching { paths.resolve(vf.path) }.getOrNull()
                if (real != null && !vf.isDirectory && vf.length <= MAX_FILE_BYTES) {
                    val text = try {
                        val doc = FileDocumentManager.getInstance().getCachedDocument(vf)
                        val t = doc?.text ?: String(vf.contentsToByteArray(), vf.charset)
                        if (isBinary(t.toByteArray(StandardCharsets.UTF_8))) null else t
                    } catch (e: Exception) {
                        null
                    }
                    text?.lineSequence()?.forEachIndexed { i, line ->
                        val hit = if (regex != null) regex.containsMatchIn(line) else line.contains(query)
                        if (hit) {
                            if (results.size < max) {
                                results.add("${paths.relative(real)}:${i + 1}: $line")
                            } else {
                                overflow++
                            }
                        }
                    }
                }
                true
            }
        }
        if (overflow > 0) results.add("[$overflow more]")
        return if (results.isEmpty()) "no matches" else results.joinToString("\n")
    }
}

private suspend fun <T> writeCommand(project: Project, name: String, block: () -> T): T {
    val app = ApplicationManager.getApplication()
    val action = com.intellij.openapi.util.ThrowableComputable<T, Exception> { block() }
    return if (app.isDispatchThread) {
        WriteCommandAction.writeCommandAction(project).withName(name).compute<T, Exception>(action)
    } else {
        withContext(Dispatchers.EDT) {
            WriteCommandAction.writeCommandAction(project).withName(name).compute<T, Exception>(action)
        }
    }
}

private suspend fun onEdt(block: () -> Unit) {
    val app = ApplicationManager.getApplication()
    if (app.isDispatchThread) block() else withContext(Dispatchers.EDT) { block() }
}

abstract class EditTool(project: Project, paths: ProjectPaths) : ProjectTool(project, paths) {
    /**
     * Reloads an unmodified document only when it differs from disk. An unconditional reload
     * is not undoable and would make the following edit impossible to undo from the editor.
     */
    private fun reloadIfStale(doc: com.intellij.openapi.editor.Document, vf: com.intellij.openapi.vfs.VirtualFile) {
        val fdm = FileDocumentManager.getInstance()
        if (fdm.isFileModified(vf)) return
        val disk = String(vf.contentsToByteArray(), vf.charset)
        if (doc.text != com.intellij.openapi.util.text.StringUtil.convertLineSeparators(disk)) fdm.reloadFromDisk(doc)
    }

    protected suspend fun currentText(p: Path): String? {
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(p.toString()) ?: return null
        if (vf.isDirectory) throw IllegalArgumentException("not a file: " + paths.relative(p))
        val doc = FileDocumentManager.getInstance().getCachedDocument(vf)
        if (doc != null && FileDocumentManager.getInstance().isFileModified(vf)) {
            return doc.text
        }
        return runReadAction {
            try {
                java.nio.file.Files.readString(p)
            } catch (e: java.io.IOException) {
                String(vf.contentsToByteArray(), vf.charset)
            }
        }
    }

    protected suspend fun applyChange(
        rawPath: String,
        arguments: JsonObject,
        change: ToolPreview.FileChange,
        computeAfter: (before: String, arguments: JsonObject) -> String,
    ) {
        val resolved = paths.resolve(rawPath)
        if (resolved.toString() != change.path) {
            throw IllegalStateException("file moved since preview; request the edit again")
        }
        var failure: RuntimeException? = null
        var writtenVf: VirtualFile? = null
        writeCommand(project, "AIJB: edit ${resolved.fileName}") {
            try {
                val rechecked = paths.resolve(rawPath)
                if (rechecked.toString() != change.path) {
                    throw IllegalStateException(
                        "file moved since preview; request the edit again")
                }
                var vfExisting = LocalFileSystem.getInstance()
                    .findFileByPath(rechecked.toString())
                var liveDoc = vfExisting?.let {
                    FileDocumentManager.getInstance().getCachedDocument(it)
                }
                if (liveDoc != null && vfExisting != null) reloadIfStale(liveDoc, vfExisting)
                if (vfExisting == null) {
                    vfExisting = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(rechecked.toString())
                    liveDoc = vfExisting?.let {
                        FileDocumentManager.getInstance().getCachedDocument(it)
                    }
                }
                liveDoc = liveDoc?.takeIf {
                    vfExisting?.let { v ->
                        FileDocumentManager.getInstance().isFileModified(v)
                    } == true
                }
                val current = liveDoc?.text ?: try {
                    java.nio.file.Files.readString(rechecked)
                } catch (e: java.nio.file.NoSuchFileException) {
                    null
                }
                if (current != change.before) {
                    throw IllegalStateException(
                        "file changed since preview; request the edit again")
                }
                val expected = computeAfter(current ?: "", arguments)
                if (expected != change.after) {
                    throw IllegalStateException(
                        "approved change does not match; request the edit again")
                }
                var vf = vfExisting
                if (vf == null) {
                    val parent = VfsUtil.createDirectoryIfMissing(rechecked.parent.toString())
                        ?: throw IllegalStateException("cannot create ${rechecked.parent}")
                    vf = parent.createChildData(this, rechecked.fileName.toString())
                }
                val doc = FileDocumentManager.getInstance().getDocument(vf)
                    ?: throw IllegalStateException("no document for ${resolved.fileName}")
                reloadIfStale(doc, vf)
                doc.setText(change.after)
                FileDocumentManager.getInstance().saveDocument(doc)
                writtenVf = vf
            } catch (e: RuntimeException) {
                failure = e
            }
        }
        failure?.let { throw it }
        val vf = writtenVf ?: return
        currentCoroutineContext().ensureActive()
        val disk = diskText(resolved, vf)
            ?: throw IllegalStateException(
                "file missing after write: ${resolved.fileName}; side effects uncertain")
        if (com.intellij.openapi.util.text.StringUtil.convertLineSeparators(disk)
            != com.intellij.openapi.util.text.StringUtil.convertLineSeparators(change.after)) {
            throw IllegalStateException(
                "file content differs from approved change; side effects uncertain: ${resolved.fileName}")
        }
    }

    protected open fun diskText(resolved: Path, vf: VirtualFile): String? = try {
        String(java.nio.file.Files.readAllBytes(resolved), vf.charset)
    } catch (e: java.io.IOException) {
        null
    }
}

class WriteFile(project: Project, paths: ProjectPaths) : EditTool(project, paths) {
    override val spec = ToolSpec("WriteFile", "Write a whole file",
        schema(mapOf("path" to str(), "content" to str()), listOf("path", "content")))
    override val requiresApproval = true

    override suspend fun preview(arguments: JsonObject): ToolPreview {
        val p = paths.resolve(args(arguments, "path"))
        return ToolPreview.FileChange(
            p.toString(), currentText(p), args(arguments, "content"))
    }

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val change = preview as? ToolPreview.FileChange
            ?: throw IllegalStateException("missing preview")
        applyChange(args(arguments, "path"), arguments, change) { _, args ->
            args(args, "content")
        }
        val lines = change.after.lines().size
        return "wrote ${paths.relative(Path.of(change.path))} ($lines lines)"
    }
}

class EditFile(project: Project, paths: ProjectPaths) : EditTool(project, paths) {
    override val spec = ToolSpec("EditFile", "Replace text in a file",
        schema(mapOf(
            "path" to str(), "old_string" to str(), "new_string" to str(), "replace_all" to bool()),
            listOf("path", "old_string", "new_string")))
    override val requiresApproval = true

    override suspend fun preview(arguments: JsonObject): ToolPreview {
        val p = paths.resolve(args(arguments, "path"))
        val rel = paths.relative(p)
        val old = args(arguments, "old_string")
        if (old.isEmpty()) throw IllegalArgumentException("old_string must not be empty")
        val before = currentText(p)
            ?: throw IllegalArgumentException("file not found: $rel")
        val occurrences = before.split(old).size - 1
        if (occurrences == 0) throw IllegalArgumentException("old_string not found in $rel")
        val all = optBool(arguments, "replace_all")
        if (occurrences > 1 && !all) {
            throw IllegalArgumentException(
                "old_string matches $occurrences times in $rel; use replace_all or more context")
        }
        val after = if (all) before.replace(old, args(arguments, "new_string"))
            else before.replaceFirst(old, args(arguments, "new_string"))
        return ToolPreview.FileChange(p.toString(), before, after)
    }

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val change = preview as? ToolPreview.FileChange
            ?: throw IllegalStateException("missing preview")
        applyChange(args(arguments, "path"), arguments, change) { before, args ->
            if (optBool(args, "replace_all")) {
                before.replace(args(args, "old_string"), args(args, "new_string"))
            } else {
                before.replaceFirst(args(args, "old_string"), args(args, "new_string"))
            }
        }
        return "edited ${paths.relative(Path.of(change.path))}"
    }
}

class RunTerminal(project: Project, paths: ProjectPaths) : ProjectTool(project, paths) {
    override val spec = ToolSpec("RunTerminal", "Run a shell command",
        schema(mapOf("command" to str(), "cwd" to str()), listOf("command")))
    override val requiresApproval = true

    override suspend fun preview(arguments: JsonObject): ToolPreview {
        val cmd = args(arguments, "command")
        val cwd = cwd(arguments)
        return ToolPreview.Command(cmd, cwd.toString())
    }

    private fun cwd(arguments: JsonObject): Path =
        arguments["cwd"]?.let { paths.resolve(it.jsonPrimitive.content) }
            ?: paths.resolve(paths.base.toString())

    override suspend fun execute(arguments: JsonObject, preview: ToolPreview?): String {
        val approved = preview as? ToolPreview.Command
            ?: throw IllegalStateException("missing preview")
        val command = args(arguments, "command")
        val cwd = cwd(arguments)
        if (approved.command != command || approved.cwd != cwd.toString()) {
            throw IllegalStateException("command changed since approval")
        }
        onEdt { FileDocumentManager.getInstance().saveAllDocuments() }
        val cmdLine = if (SystemInfo.isWindows) {
            GeneralCommandLine("cmd", "/c", command)
        } else {
            GeneralCommandLine("/bin/sh", "-c", command)
        }
        cmdLine.withWorkDirectory(cwd.toFile())
        cmdLine.withRedirectErrorStream(true)
        val proc = withContext(Dispatchers.IO) { cmdLine.createProcess() }
        val output = StringBuilder()
        return coroutineScope {
            val reader = async(Dispatchers.IO) {
                runCatching {
                    proc.inputStream.bufferedReader().use { r ->
                        val buf = CharArray(8192)
                        while (true) {
                            val n = r.read(buf)
                            if (n < 0) break
                            if (output.length < MAX_COMMAND_OUTPUT) {
                                output.append(buf, 0, minOf(n, MAX_COMMAND_OUTPUT - output.length))
                            }
                        }
                    }
                }
            }
            try {
                val exit = withContext(Dispatchers.IO) {
                    while (proc.isAlive) {
                        currentCoroutineContext().ensureActive()
                        proc.waitFor(50, java.util.concurrent.TimeUnit.MILLISECONDS)
                    }
                    proc.exitValue()
                }
                reader.await()
                "exit code: $exit\n$output"
            } catch (e: CancellationException) {
                proc.toHandle().descendants().forEach { it.destroyForcibly() }
                proc.toHandle().destroyForcibly()
                reader.await()
                throw e
            }
        }
    }
}

object ProjectTools {
    fun registry(project: Project, enabled: Boolean): ToolRegistry {
        if (!enabled) return ToolRegistry(emptyList())
        val paths = ProjectPaths.forProject(project)
        return ToolRegistry(listOf(
            ReadFile(project, paths), FindFiles(project, paths), Search(project, paths),
            WriteFile(project, paths), EditFile(project, paths), RunTerminal(project, paths),
        ))
    }
}

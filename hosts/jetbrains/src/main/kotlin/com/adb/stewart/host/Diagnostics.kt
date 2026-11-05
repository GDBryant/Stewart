package com.adb.stewart.host

import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.util.CommonProcessors
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

/** `diag.problems`: last-computed highlighting results (severity >= INFORMATION). */
class Diagnostics(private val project: Project) {

    fun severityName(s: HighlightSeverity): String = when {
        s >= HighlightSeverity.ERROR -> "Error"
        s >= HighlightSeverity.WARNING -> "Warning"
        s >= HighlightSeverity.WEAK_WARNING -> "Hint"
        else -> "Information"
    }

    fun problems(path: String?): JsonElement {
        val targets = if (path != null) {
            val base = project.basePath ?: return JsonArray(emptyList())
            val vf = LocalFileSystem.getInstance().findFileByIoFile(File(base, path)) ?: return JsonArray(emptyList())
            listOf(vf)
        } else {
            FileEditorManager.getInstance(project).openFiles.toList()
        }
        val fdm = FileDocumentManager.getInstance()
        val base = project.basePath ?: ""
        val out = mutableListOf<JsonElement>()
        ApplicationManager.getApplication().runReadAction(Computable {
            for (vf in targets) {
                val doc = fdm.getDocument(vf) ?: continue
                val collector = CommonProcessors.CollectProcessor<com.intellij.codeInsight.daemon.impl.HighlightInfo>()
                DaemonCodeAnalyzerEx.processHighlights(doc, project, HighlightSeverity.INFORMATION, 0, doc.textLength, collector)
                val rel = if (base.isNotEmpty()) vf.path.removePrefix("$base/") else vf.path
                for (hi in collector.results) {
                    val line = doc.getLineNumber(hi.startOffset) + 1
                    out.add(
                        buildJsonObject {
                            put("path", JsonPrimitive(rel))
                            put("line", JsonPrimitive(line))
                            put("message", JsonPrimitive(hi.description ?: ""))
                            put("severity", JsonPrimitive(severityName(hi.severity)))
                        },
                    )
                }
            }
        })
        return JsonArray(out)
    }
}

package com.adb.stewart

import com.adb.stewart.host.Diagnostics
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

class DiagnosticsTest : BasePlatformTestCase() {
    fun testSeverityNames() {
        val d = Diagnostics(project)
        assertEquals("Error", d.severityName(HighlightSeverity.ERROR))
        assertEquals("Warning", d.severityName(HighlightSeverity.WARNING))
        assertEquals("Hint", d.severityName(HighlightSeverity.WEAK_WARNING))
        assertEquals("Information", d.severityName(HighlightSeverity.INFORMATION))
    }

    fun testProblemsForMissingFile() {
        val d = Diagnostics(project)
        assertTrue(d.problems("no/such/File.kt").jsonArray.isEmpty())
    }

    fun testProblemsForAllOpenFiles() {
        val vf = myFixture.addFileToProject("open-me.kt", "class A")
        FileEditorManager.getInstance(project).openFile(vf.virtualFile, true)
        val d = Diagnostics(project)
        val r = d.problems(null).jsonArray
        assertTrue(r.isEmpty() || r.all { it.jsonObject.containsKey("path") })
    }

    fun testProblemsForExistingFile() {
        myFixture.addFileToProject("clean.kt", "class B")
        val d = Diagnostics(project)
        d.problems("clean.kt")
    }

    fun testProblemsReturnsHighlights() {
        myFixture.configureByText(
            "Broken.java",
            "class Broken { void m() { totallyUndefinedMethod(); } }",
        )
        myFixture.doHighlighting()
        val d = Diagnostics(project)
        val out = d.problems(null).jsonArray
        assertTrue(out.isNotEmpty())
        val first = out.first().jsonObject
        assertTrue(first.containsKey("path") && first.containsKey("line") && first.containsKey("message") && first.containsKey("severity"))
    }
}

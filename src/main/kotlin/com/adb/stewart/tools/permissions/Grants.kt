package com.adb.stewart.tools.permissions

import com.adb.stewart.tools.ApprovalDecision
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project

enum class GrantScope {
    CHAT,
    ALWAYS,
}

sealed interface GrantTarget {
    data class Category(val category: ApprovalCategory) : GrantTarget
    data class Programs(val names: Set<String>) : GrantTarget
}

data class Grant(val scope: GrantScope, val target: GrantTarget)

data class PromptResult(val decision: ApprovalDecision, val grant: Grant? = null)

/**
 * Writes an "always in this project" grant; runs on the EDT inside the default implementation so
 * the persistent component is only mutated there. A seam so tests need no real service.
 */
fun interface AlwaysGrantWriter {
    fun record(project: Project, target: GrantTarget)

    companion object {
        val DEFAULT: AlwaysGrantWriter = AlwaysGrantWriter { project, target ->
            ApplicationManager.getApplication().invokeAndWait {
                val store = ProjectPermissions.getInstance()
                when (target) {
                    is GrantTarget.Category -> store.setTick(project, target.category, true)
                    is GrantTarget.Programs -> target.names.forEach { store.addProgram(project, it) }
                }
            }
        }
    }
}

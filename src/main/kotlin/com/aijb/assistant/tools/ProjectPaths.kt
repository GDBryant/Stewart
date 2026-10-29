package com.aijb.assistant.tools

import java.nio.file.Files
import java.nio.file.Path

class ProjectPaths(roots: List<Path>, val base: Path) {
    private val realRoots: List<Path> = roots.map { it.toAbsolutePath().normalize().toRealOrSelf() }

    private fun Path.toRealOrSelf(): Path =
        if (Files.exists(this)) toRealPath() else this

    fun resolve(raw: String): Path {
        if (raw.isBlank()) throw IllegalArgumentException("path outside project: $raw")
        val p = Path.of(raw)
        val abs = if (p.isAbsolute) p.normalize() else base.toAbsolutePath().normalize().resolve(p).normalize()
        var ancestor = abs
        val tail = mutableListOf<Path>()
        while (!Files.exists(ancestor, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            val parent = ancestor.parent
                ?: throw IllegalArgumentException("path outside project: $raw")
            tail.add(0, ancestor.fileName)
            ancestor = parent
        }
        var real = try {
            ancestor.toRealPath()
        } catch (e: java.io.IOException) {
            throw IllegalArgumentException("path outside project: $raw")
        }
        for (seg in tail) real = real.resolve(seg)
        if (realRoots.none { root -> real.startsWith(root) }) {
            throw IllegalArgumentException("path outside project: $raw")
        }
        return real
    }

    fun relative(p: Path): String =
        if (p.startsWith(base)) base.relativize(p).toString() else p.toString()

    companion object {
        fun forProject(project: com.intellij.openapi.project.Project): ProjectPaths {
            val roots = mutableListOf<Path>()
            project.basePath?.let { roots.add(Path.of(it)) }
            com.intellij.openapi.roots.ProjectRootManager.getInstance(project)
                .contentRoots.forEach { roots.add(Path.of(it.path)) }
            return ProjectPaths(roots.distinct(), Path.of(project.basePath ?: roots.first().toString()))
        }
    }
}

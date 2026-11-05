package com.adb.stewart.sidecar

import java.io.File

/**
 * Resolves the Node 22 executable for the sidecar: a bundled copy under the
 * plugin's extracted resource dir first (`node/<os>-<arch>/node`), else `node`
 * on PATH. M9 ships the per-OS bundled zips; PATH is the dev fallback.
 */
object NodeLocator {
    fun osKey(osName: String, osArch: String): String? {
        val os = when {
            osName.startsWith("Windows") -> "windows"
            osName.startsWith("Mac") || osName.startsWith("Darwin") -> "macos"
            osName.startsWith("Linux") -> "linux"
            else -> return null
        }
        val arch = when {
            osArch == "aarch64" || osArch == "arm64" -> "arm64"
            osArch.startsWith("x86") || osArch == "amd64" -> "x64"
            else -> return null
        }
        return "$os-$arch"
    }

    fun bundledNode(root: File, osName: String = System.getProperty("os.name"), osArch: String = System.getProperty("os.arch")): File? {
        val key = osKey(osName, osArch) ?: return null
        val exe = if (key.startsWith("windows")) "node.exe" else "node"
        val f = File(File(root, "node"), "$key/$exe")
        return if (f.isFile) f else null
    }

    fun onPath(pathEnv: String? = System.getenv("PATH"), osName: String = System.getProperty("os.name")): File? {
        if (pathEnv.isNullOrBlank()) return null
        val exe = if (osName.startsWith("Windows")) "node.exe" else "node"
        for (dir in pathEnv.split(File.pathSeparator)) {
            if (dir.isBlank()) continue
            val f = File(dir, exe)
            if (f.isFile && f.canExecute()) return f
        }
        return null
    }

    fun resolve(bundledRoot: File?, pathEnv: String? = System.getenv("PATH")): File? =
        bundledRoot?.let { bundledNode(it) } ?: onPath(pathEnv)
}

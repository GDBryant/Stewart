package com.adb.stewart.sidecar

import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Resolves the Node 22 executable for the sidecar: a bundled copy under the
 * plugin's extracted resource dir first (`node/<os>-<arch>/node`), else a `node`
 * on PATH. The PATH fallback must pass the version probe (`node --version`,
 * timeout-bounded, major >= 22) so an old system node is never selected.
 */
object NodeLocator {
    const val MIN_MAJOR = 22
    const val PROBE_TIMEOUT_MS = 3_000L
    private val VERSION_RE = Regex("""v?(\d+)\.\d+\.\d+""")

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

    /** Runs `<exe> --version` (timeout-bounded) and parses the major version; null on spawn failure, timeout or unparseable output. */
    fun probeMajor(exe: File, timeoutMs: Long = PROBE_TIMEOUT_MS): Int? {
        val p = try {
            ProcessBuilder(listOf(exe.absolutePath, "--version")).redirectErrorStream(true).start()
        } catch (e: IOException) {
            return null
        }
        return try {
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) return null
            val m = VERSION_RE.find(p.inputStream.bufferedReader().readText()) ?: return null
            m.groupValues[1].toInt()
        } finally {
            p.destroyForcibly()
        }
    }

    /** First PATH entry holding an executable `node` whose [probe] reports major >= [MIN_MAJOR]. */
    fun onPath(
        pathEnv: String? = System.getenv("PATH"),
        osName: String = System.getProperty("os.name"),
        probe: (File) -> Int? = ::probeMajor,
    ): File? {
        if (pathEnv.isNullOrBlank()) return null
        val exe = if (osName.startsWith("Windows")) "node.exe" else "node"
        for (dir in pathEnv.split(File.pathSeparator)) {
            if (dir.isBlank()) continue
            val f = File(dir, exe)
            if (f.isFile && f.canExecute() && (probe(f) ?: 0) >= MIN_MAJOR) return f
        }
        return null
    }

    fun resolve(
        bundledRoot: File?,
        pathEnv: String? = System.getenv("PATH"),
        probe: (File) -> Int? = ::probeMajor,
    ): File? = bundledRoot?.let { bundledNode(it) } ?: onPath(pathEnv, probe = probe)
}

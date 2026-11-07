package com.adb.stewart

import java.io.File

/**
 * Shared per-user config dir, identical for every IDE and project (mirrors core `sharedUserConfigDir`):
 * `STEWART_CONFIG_DIR` > `XDG_CONFIG_HOME/stewart` > `%APPDATA%\stewart` (Windows) > `~/.config/stewart`.
 */
object UserConfigDir {
    private val FILES = listOf("channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml")

    fun shared(
        env: Map<String, String> = System.getenv(),
        home: String = System.getProperty("user.home"),
        windows: Boolean = System.getProperty("os.name").startsWith("Windows"),
    ): File = when {
        !env["STEWART_CONFIG_DIR"].isNullOrEmpty() -> File(env.getValue("STEWART_CONFIG_DIR"))
        !env["XDG_CONFIG_HOME"].isNullOrEmpty() -> File(env.getValue("XDG_CONFIG_HOME"), "stewart")
        windows && !env["APPDATA"].isNullOrEmpty() -> File(env.getValue("APPDATA"), "stewart")
        else -> File(home, ".config/stewart")
    }

    /** Old per-project dirs under the IDE config path: this project's first, then others newest first. */
    fun legacyDirs(root: File, projectHash: String): List<File> {
        val all = root.listFiles { f -> f.isDirectory }?.toList().orEmpty()
        val mine = all.filter { it.name == projectHash }
        return mine + all.filter { it.name != projectHash }.sortedByDescending { it.lastModified() }
    }

    /** Create [dir] (+ `skills/`) and copy files it lacks from [legacy] dirs; never overwrites or deletes. */
    fun ensure(dir: File, legacy: List<File> = emptyList()): File {
        File(dir, "skills").mkdirs()
        for (l in legacy) {
            if (l.canonicalFile == dir.canonicalFile) continue
            for (f in FILES) copyMissing(File(l, f), File(dir, f))
            File(l, "skills").listFiles { f -> f.isFile && f.name.endsWith(".md") }
                ?.forEach { copyMissing(it, File(File(dir, "skills"), it.name)) }
        }
        return dir
    }

    private fun copyMissing(src: File, dst: File) {
        if (dst.exists() || !src.isFile) return
        try {
            dst.parentFile?.mkdirs()
            src.copyTo(dst)
        } catch (_: Exception) {
            /* best effort; defaults apply */
        }
    }
}

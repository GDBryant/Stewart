package com.adb.stewart

/**
 * Remote-development detection. Gateway/remote backends expose
 * `AppMode.isRemoteDevHost`; checked reflectively so older platform builds
 * without that method simply report local.
 */
object Env {
    fun isRemoteDev(probe: () -> Boolean = ::defaultProbe): Boolean = try {
        probe()
    } catch (_: Throwable) {
        false
    }

    private fun defaultProbe(): Boolean = try {
        val cls = Class.forName("com.intellij.idea.AppMode")
        (cls.getMethod("isRemoteDevHost").invoke(null) as? Boolean) == true
    } catch (_: Throwable) {
        false
    }
}

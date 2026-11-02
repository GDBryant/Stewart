package com.adb.stewart.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.JDOMUtil
import com.intellij.util.xmlb.XmlSerializer
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * One-shot migration of data persisted under the pre-rename "AIJB Assistant" names. The old data is
 * only ever read (copied), never moved, so the old plugin keeps working if it is still installed.
 */
object LegacyMigration {
    const val SETTINGS_FILE = "aijb-assistant.xml"
    const val SETTINGS_COMPONENT = "AijbAssistantSettings"
    const val PERMISSIONS_FILE = "aijb-permissions.xml"
    const val PERMISSIONS_COMPONENT = "AijbPermissions"
    const val HISTORY_DIR = "aijb-assistant"
    const val CREDENTIAL_SUBSYSTEM = "AIJB Assistant"

    private val LOG = Logger.getInstance(LegacyMigration::class.java)

    /** Old app-level storage file. Always under the IDE options dir, never a project path a repo could plant. */
    fun optionsFile(name: String): Path = Path.of(PathManager.getOptionsPath(), name)

    /** True when [state] holds nothing beyond a freshly constructed [fresh]. */
    fun isUntouched(state: BaseState, fresh: BaseState): Boolean =
        state.modificationCount == 0L ||
            JDOMUtil.areElementsEqual(XmlSerializer.serialize(state), XmlSerializer.serialize(fresh))

    /** The [component] element of [file] deserialized as [type]; null when absent or unreadable. */
    fun <T : Any> readState(file: Path, component: String, type: Class<T>): T? {
        if (!Files.isRegularFile(file)) return null
        return try {
            val element = JDOMUtil.load(file).getChildren("component")
                .firstOrNull { it.getAttributeValue("name") == component } ?: return null
            XmlSerializer.deserialize(element, type)
        } catch (e: Exception) {
            LOG.warn("Could not read legacy $component from ${file.fileName}: ${e.javaClass.simpleName}")
            null
        }
    }

    /** Loads the legacy state into the component via [apply] when [current] is untouched; true if it did. */
    fun <T : BaseState> migrateState(current: T, fresh: T, file: Path, component: String, apply: (T) -> Unit): Boolean {
        if (!isUntouched(current, fresh)) return false
        val legacy = readState(file, component, fresh.javaClass) ?: return false
        apply(legacy)
        LOG.info("Migrated $component from ${file.fileName}")
        return true
    }

    /**
     * Returns the credential under [target]; when it is empty, copies the one under [legacy] to [target]
     * (keeping the old entry) and returns that.
     */
    fun migrateCredential(
        target: CredentialAttributes,
        legacy: CredentialAttributes,
        get: (CredentialAttributes) -> Credentials?,
        set: (CredentialAttributes, Credentials) -> Unit,
    ): Credentials? {
        get(target)?.takeIf { !it.getPasswordAsString().isNullOrEmpty() }?.let { return it }
        val old = get(legacy)?.takeIf { !it.getPasswordAsString().isNullOrEmpty() } ?: return null
        set(target, old)
        return old
    }

    /**
     * Copies [legacyDir] to [targetDir] when the target is missing. Copies into a sibling staging dir and
     * renames it, so a failed copy leaves no target and is retried next time. File times are kept so
     * retention pruning does not restart. True if it copied.
     */
    @Synchronized
    fun copyDir(legacyDir: Path, targetDir: Path): Boolean {
        if (Files.exists(targetDir) || !Files.isDirectory(legacyDir)) return false
        val staging = targetDir.resolveSibling(targetDir.fileName.toString() + ".migrating")
        return try {
            deleteTree(staging)
            Files.walk(legacyDir).use { paths ->
                paths.forEach { src ->
                    val dst = staging.resolve(legacyDir.relativize(src).toString())
                    if (Files.isDirectory(src)) {
                        Files.createDirectories(dst)
                    } else {
                        Files.copy(src, dst, StandardCopyOption.COPY_ATTRIBUTES)
                    }
                }
            }
            Files.move(staging, targetDir, StandardCopyOption.ATOMIC_MOVE)
            LOG.info("Copied legacy ${legacyDir.fileName} to ${targetDir.fileName}")
            true
        } catch (e: Exception) {
            LOG.warn("Could not copy legacy ${legacyDir.fileName}: ${e.javaClass.simpleName}")
            runCatching { deleteTree(staging) }
            false
        }
    }

    private fun deleteTree(dir: Path) {
        if (!Files.exists(dir)) return
        Files.walk(dir).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::delete) }
    }
}

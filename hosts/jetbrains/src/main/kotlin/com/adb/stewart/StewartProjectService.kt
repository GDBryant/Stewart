package com.adb.stewart

import com.adb.stewart.host.HostRequestHandler
import com.adb.stewart.host.ProcessRegistry
import com.adb.stewart.rpc.Link
import com.adb.stewart.sidecar.NodeLocator
import com.adb.stewart.sidecar.SidecarSupervisor
import com.adb.stewart.webview.StewartPanel
import com.adb.stewart.webview.ThemeCss
import com.adb.stewart.webview.WebviewResources
import com.adb.stewart.webview.WebviewRouter
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Per-project owner of the sidecar: extracts resources, spawns the supervisor,
 * attaches the project (config dirs, protocol handshake), wires host.* requests
 * and forwards `event` notifications to open webview panels.
 */
@Service(Service.Level.PROJECT)
class StewartProjectService(private val project: Project) : Disposable {
    companion object {
        private val LOG = Logger.getInstance(StewartProjectService::class.java)
        fun getInstance(project: Project): StewartProjectService = project.service()
    }

    private val stateRoot = File(PathManager.getConfigPath(), "stewart")
    private val legacyUserConfigRoot = File(stateRoot, "user-config")
    private val userConfigDir: File = UserConfigDir.ensure(
        UserConfigDir.shared(),
        UserConfigDir.legacyDirs(legacyUserConfigRoot, project.locationHash),
    )
    private val runtimeDir = File(stateRoot, "runtime")
    private val panels = CopyOnWriteArrayList<StewartPanel>()

    private val procs = ProcessRegistry { method, params -> supervisor?.notify(method, params) }
    private val hostHandler = HostRequestHandler(project, procs = procs)
    private var supervisor: SidecarSupervisor? = null

    val projectId: String = project.locationHash

    fun ensureStarted() {
        if (supervisor != null) return
        val entry = WebviewResources.extractSidecar(runtimeDir)
        val node = NodeLocator.resolve(runtimeDir)
        val cmd = if (node != null) {
            listOf(node.absolutePath, entry.absolutePath)
        } else {
            LOG.warn("no Node runtime found (no bundled node and no node on PATH); sidecar cannot start")
            return
        }
        val sup = SidecarSupervisor(cmd, workingDir = project.basePath?.let { File(it) })
        supervisor = sup
        sup.onLinkReady = { link -> wireLink(link) }
        sup.onExit = { code -> LOG.warn("stewart sidecar exited with code $code; in-flight runs marked failed") }
        sup.onStateChanged = { s ->
            if (s == com.adb.stewart.sidecar.SupervisorState.DEGRADED) {
                pushToPanels(JsonObject(mapOf("type" to JsonPrimitive("error"), "message" to JsonPrimitive("sidecar crash loop; restart from the tool window menu"))))
            }
        }
        sup.start()
    }

    private fun wireLink(link: Link) {
        SidecarWiring.attach(
            link,
            hostHandler,
            projectId,
            userConfigDir,
            File(project.basePath ?: "", ".stewart"),
            pushInbound = { msg -> pushToPanels(msg) },
            debugLogDir = File(PathManager.getLogPath(), "stewart/debug_logs"),
        )
    }

    /** Inbound webview message (e.g. "insertText" from Add Selection to Chat). */
    fun pushInbound(msg: JsonObject) = pushToPanels(msg)

    fun createPanel(): StewartPanel {
        lateinit var panel: StewartPanel
        val router = WebviewRouter(
            projectId = { projectId },
            request = { m, p -> supervisorRequest(m, p) },
            send = { msg -> panel.pushInbound(msg) },
            userConfigDir = { userConfigDir },
            openInEditor = { f ->
                LocalFileSystem.getInstance().refreshAndFindFileByIoFile(f)?.let {
                    FileEditorManager.getInstance(project).openFile(it, true)
                }
            },
        )
        panel = StewartPanel({ bridge -> WebviewResources.webviewHtml(bridge, themeCss = ThemeCss.css(ThemeCss.current())) }) { raw -> router.route(raw) }
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            LafManagerListener.TOPIC,
            LafManagerListener { panel.applyTheme(ThemeCss.css(ThemeCss.current())) },
        )
        panels.add(panel)
        return panel
    }

    private fun supervisorRequest(method: String, params: JsonObject?): java.util.concurrent.CompletableFuture<JsonElement?> {
        val sup = supervisor ?: return java.util.concurrent.CompletableFuture<JsonElement?>().apply {
            completeExceptionally(IllegalStateException("sidecar not running"))
        }
        return sup.request(method, params)
    }

    internal var inboundObserver: ((JsonObject) -> Unit)? = null

    private fun pushToPanels(msg: JsonObject) {
        inboundObserver?.invoke(msg)
        for (p in panels) p.pushInbound(msg)
    }

    override fun dispose() {
        panels.forEach { it.dispose() }
        panels.clear()
        hostHandler.dispose()
        supervisor?.dispose()
        supervisor = null
    }
}

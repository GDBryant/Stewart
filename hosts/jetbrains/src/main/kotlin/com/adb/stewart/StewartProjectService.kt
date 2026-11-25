package com.adb.stewart

import com.adb.stewart.host.HostRequestHandler
import com.adb.stewart.host.ProcessRegistry
import com.adb.stewart.rpc.Link
import com.adb.stewart.sidecar.NodeFetcher
import com.adb.stewart.sidecar.NodeLocator
import com.adb.stewart.sidecar.SidecarSupervisor
import com.adb.stewart.sidecar.SupervisorState
import com.adb.stewart.webview.StewartPanel
import com.adb.stewart.webview.ThemeCss
import com.adb.stewart.webview.WebviewResources
import com.adb.stewart.webview.WebviewRouter
import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
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
 * Per-project owner of the sidecar: extracts resources, resolves a Node 22
 * runtime (bundled → self-installed cache → PATH v22+ → nodejs.org download),
 * spawns the supervisor, attaches the project (config dirs, protocol handshake),
 * wires host.* requests and forwards `event` notifications to open webview
 * panels. Startup failures surface as an actionable balloon + webview error.
 */
@Service(Service.Level.PROJECT)
class StewartProjectService(private val project: Project) : Disposable {
    companion object {
        private val LOG = Logger.getInstance(StewartProjectService::class.java)
        private const val GROUP = "Stewart"
        fun getInstance(project: Project): StewartProjectService = project.service()
    }

    private val stateRoot = File(PathManager.getConfigPath(), "stewart")
    private val legacyUserConfigRoot = File(stateRoot, "user-config")
    private val userConfigDir: File = UserConfigDir.ensure(
        UserConfigDir.shared(),
        UserConfigDir.legacyDirs(legacyUserConfigRoot, project.locationHash),
    )
    private val runtimeDir = File(stateRoot, "runtime")
    private val nodeCacheDir = File(stateRoot, "node")
    private val panels = CopyOnWriteArrayList<StewartPanel>()

    private val procs = ProcessRegistry { method, params -> supervisor?.notify(method, params) }
    private val hostHandler = HostRequestHandler(project, procs = procs)
    @Volatile private var supervisor: SidecarSupervisor? = null
    @Volatile private var startInProgress = false

    val projectId: String = project.locationHash

    /**
     * Starts the sidecar if no usable one is running: resolves Node 22
     * (bundled → self-installed cache → PATH; downloads into the cache in a
     * cancellable background task when missing) and spawns the supervisor.
     */
    fun ensureStarted() {
        val sup = supervisor
        if (sup != null && sup.state == SupervisorState.RUNNING) return
        if (startInProgress) return
        startInProgress = true
        // Any non-running supervisor (STARTING / STOPPED / DEGRADED) from a
        // previous start is stale: its auto-restart loop must not outlive the
        // new one, so dispose it before spawning.
        val stale = if (sup == null || sup.state == SupervisorState.RUNNING) null else sup
        if (stale != null) {
            ApplicationManager.getApplication().invokeLater {
                if (supervisor === stale && stale.state != SupervisorState.RUNNING) {
                    disposeSupervisor()
                }
            }
        }
        val entry = WebviewResources.extractSidecar(runtimeDir)
        // `queue()` schedules a background (non-modal) task and returns
        // immediately, so this never blocks the EDT even while a Node
        // download runs; cancellation goes through the progress UI.
        // `installed` records the supervisor this particular task installed, so
        // a cancelled task can only tear down its own instance and never a
        // fresh one a later restart has since started. Both the write (via
        // startSupervisor's onInstalled) and the read (onCancel) run on the
        // EDT, so no extra synchronization is needed.
        var installed: SidecarSupervisor? = null
        object : Task.Backgroundable(project, "Starting Stewart") {
            override fun run(indicator: ProgressIndicator) {
                val (node, downloaded) = try {
                    NodeFetcher.resolveNode(
                        bundledRoot = runtimeDir,
                        cacheDir = nodeCacheDir,
                        onProgress = { msg -> if (!indicator.isCanceled) indicator.setText2(msg) },
                        canceled = { indicator.isCanceled },
                    )
                } catch (e: Exception) {
                    // A user cancel aborts the download by throwing
                    // "download cancelled"; surface that as a neutral message,
                    // not a startup failure.
                    if (indicator.isCanceled) {
                        startInProgress = false
                        notifyStartCancelled()
                        return
                    }
                    // Download/checksum/extraction failure: actionable balloon + webview error.
                    startInProgress = false
                    notifyStartupFailure(e)
                    return
                }
                try {
                    // User cancelled the progress UI: don't spawn after a
                    // cancelled download.
                    if (indicator.isCanceled) {
                        startInProgress = false
                        notifyStartCancelled()
                        return
                    }
                    startSupervisor(entry, node, downloaded, canceled = { indicator.isCanceled }) { s -> installed = s }
                } catch (e: Exception) {
                    startInProgress = false
                    LOG.warn("stewart start failed", e)
                    notifyBalloon("Stewart sidecar failed to start", e.message ?: e.javaClass.simpleName, NotificationType.ERROR)
                }
            }

            override fun onCancel() {
                // startSupervisor posts to the EDT, so it may install a
                // supervisor just as this task is cancelled; tear down only the
                // instance this task installed, and only if it is still current.
                ApplicationManager.getApplication().invokeLater {
                    val s = installed
                    if (s != null && supervisor === s) {
                        disposeSupervisor()
                    }
                }
            }
        }.queue()
    }

    /** Disposes the running sidecar (if any) and runs the full start (re-)resolution. */
    fun restart() {
        disposeSupervisor()
        ensureStarted()
    }

    /** Called from the background start task; runs the spawn on the EDT. [canceled] is re-checked there because the user may cancel right after [startSupervisor] is called, and [onInstalled] reports the installed instance to the task so it can guard its own teardown. */
    private fun startSupervisor(
        entry: File,
        node: File,
        downloaded: Boolean,
        canceled: () -> Boolean = { false },
        onInstalled: (SidecarSupervisor) -> Unit = {},
    ) {
        ApplicationManager.getApplication().invokeLater {
            // A cancel may land after the background task returned but before
            // this EDT block runs: don't install a supervisor no one will tear
            // down (and release the start latch so the next start proceeds).
            if (canceled()) {
                startInProgress = false
                return@invokeLater
            }
            val cmd = listOf(node.absolutePath, entry.absolutePath)
            val sup = SidecarSupervisor(cmd, workingDir = project.basePath?.let { File(it) })
            supervisor = sup
            onInstalled(sup)
            sup.onLinkReady = { link ->
                wireLink(link)
                if (downloaded) {
                    notifyBalloon(
                        "Stewart installed Node ${NodeFetcher.VERSION} (self-heal)",
                        "Downloaded from nodejs.org and cached in ${nodeCacheDir.absolutePath}. The per-OS plugin zips bundle the runtime, so no download is needed on those machines.",
                        NotificationType.INFORMATION,
                    )
                }
            }
            sup.onExit = { code -> LOG.warn("stewart sidecar exited with code $code; in-flight runs marked failed") }
            sup.onStateChanged = { s ->
                if (s == SupervisorState.DEGRADED) {
                    pushToPanels(buildJsonObject {
                        put("type", JsonPrimitive("error"))
                        put("message", JsonPrimitive("sidecar crash loop; restart from the tool window menu"))
                    })
                }
            }
            sup.start()
            // The (re)start is settled: the supervisor now self-manages crash
            // loops / auto-restarts, so release the start latch. Without this a
            // successful start leaves startInProgress=true and every later
            // restart()/ensureStarted() bails at the `if (startInProgress)` guard.
            startInProgress = false
        }
    }

    private fun disposeSupervisor() {
        val sup = supervisor ?: return
        sup.onLinkReady = null
        sup.onExit = null
        sup.onStateChanged = null
        sup.dispose()
        supervisor = null
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

    /** Neutral balloon for a user-initiated cancel of the start/download. */
    private fun notifyStartCancelled() {
        notifyBalloon(
            "Stewart start cancelled",
            "Press Tools → Restart Stewart Sidecar (or reopen the tool window) to try again.",
            NotificationType.INFORMATION,
        )
    }

    /** Balloon (with Retry) + webview-visible error for Node/sidecar startup failures. */
    internal fun notifyStartupFailure(cause: Throwable) {
        LOG.warn("stewart startup failure", cause)
        val osName = System.getProperty("os.name")
        val osArch = System.getProperty("os.arch")
        val knownPlatform = NodeLocator.osKey(osName, osArch) != null && NodeFetcher.target(osName, osArch) != null
        val title = if (knownPlatform) "Stewart sidecar failed to start" else "Stewart cannot start on this platform"
        val detail = if (knownPlatform) {
            """
            ${cause.message ?: cause.javaClass.simpleName}
            Stewart needs a Node.js 22 runtime. Options:
            • press Retry (re-downloads from nodejs.org)
            • use the per-OS plugin zip (bundles the runtime; see Releasing docs)
            • install Node.js 22+ yourself (https://nodejs.org) and retry
            """.trimIndent()
        } else {
            "Unsupported OS/architecture: $osName/$osArch. No Node ${NodeFetcher.VERSION} archive is published for it; Stewart cannot self-install a runtime here."
        }
        ApplicationManager.getApplication().invokeLater {
            val notification = notifyBalloon(title, detail, NotificationType.ERROR)
            notification.addAction(object : AnAction("Retry") {
                override fun actionPerformed(e: AnActionEvent) {
                    ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Restarting Stewart") {
                        override fun run(indicator: ProgressIndicator) {
                            indicator.text2 = "Restarting Stewart sidecar…"
                            restart()
                        }
                    })
                }
            })
            pushToPanels(buildJsonObject {
                put("type", JsonPrimitive("error"))
                put("message", JsonPrimitive("Stewart sidecar failed to start: ${cause.message ?: cause.javaClass.simpleName}"))
            })
        }
    }

    private fun notifyBalloon(title: String, content: String, type: NotificationType): com.intellij.notification.Notification =
        com.intellij.notification.NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP)
            .createNotification(title, content, type)
            .also { it.notify(project) }

    override fun dispose() {
        panels.forEach { it.dispose() }
        panels.clear()
        hostHandler.dispose()
        disposeSupervisor()
    }
}

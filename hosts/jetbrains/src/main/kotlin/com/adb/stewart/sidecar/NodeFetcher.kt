package com.adb.stewart.sidecar

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.GZIPInputStream
import java.util.zip.ZipInputStream
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream

/** Platform target: mirrors scripts/bundle-node.mjs TARGETS (member = archive-internal node path). */
data class NodeTarget(
    val osKey: String,
    val archive: String,
    val member: String,
    val exe: String,
)

/**
 * Self-healing Node runtime: downloads an official nodejs.org archive for
 * [VERSION], verifies it against SHASUMS256 and caches the node binary under
 * <cacheDir>/<os-key>/<exe>, so a machine without a bundled or suitable PATH
 * node can still run the sidecar. [fetch] never touches the network when a
 * cache copy already exists. [NodeTarget.member] is the full archive-internal
 * path (nodejs.org archives root every entry under `node-v<VERSION>-<plat>/`),
 * mirroring `scripts/bundle-node.mjs` TARGETS.
 */
object NodeFetcher {
    const val VERSION = "22.20.0"
    const val DEFAULT_BASE_URL = "https://nodejs.org/dist/v$VERSION"
    private const val ARCHIVE_CAP = 150L * 1024 * 1024
    private const val CHUNK = 8192

    class NodeFetchException(message: String) : Exception(message)

    /** Target for the given platform, or null when nodejs.org has no archive for it. */
    fun target(osName: String = System.getProperty("os.name"), osArch: String = System.getProperty("os.arch")): NodeTarget? {
        val key = NodeLocator.osKey(osName, osArch) ?: return null
        return when (key) {
            "linux-x64" -> NodeTarget(key, "node-v$VERSION-linux-x64.tar.gz", "node-v$VERSION-linux-x64/bin/node", "node")
            "linux-arm64" -> NodeTarget(key, "node-v$VERSION-linux-arm64.tar.gz", "node-v$VERSION-linux-arm64/bin/node", "node")
            "macos-x64" -> NodeTarget(key, "node-v$VERSION-darwin-x64.tar.gz", "node-v$VERSION-darwin-x64/bin/node", "node")
            "macos-arm64" -> NodeTarget(key, "node-v$VERSION-darwin-arm64.tar.gz", "node-v$VERSION-darwin-arm64/bin/node", "node")
            "windows-x64" -> NodeTarget(key, "node-v$VERSION-win-x64.zip", "node-v$VERSION-win-x64/node.exe", "node.exe")
            else -> null
        }
    }

    /** The cached node executable for [osKey] under [cacheDir], if present. */
    fun cached(cacheDir: File, osKey: String): File? {
        val exe = if (osKey.startsWith("windows")) "node.exe" else "node"
        val f = File(File(cacheDir, osKey), exe)
        return if (f.isFile) f else null
    }

    /**
     * Resolution chain: bundled → cache → PATH (v22+ probe) → download.
     * Returns the node executable plus whether it was downloaded by this call.
     */
    fun resolveNode(
        bundledRoot: File?,
        cacheDir: File,
        onProgress: (String) -> Unit = {},
        pathEnv: String? = System.getenv("PATH"),
        probe: (File) -> Int? = NodeLocator::probeMajor,
        canceled: () -> Boolean = { false },
        fetch: (NodeTarget, File, (Long, Long) -> Unit, () -> Boolean) -> File = { t, c, p, can -> NodeFetcher.fetch(t, c, onProgress = p, canceled = can) },
    ): Pair<File, Boolean> {
        bundledRoot?.let { NodeLocator.bundledNode(it) }?.let { return it to false }
        val key = NodeLocator.osKey(System.getProperty("os.name"), System.getProperty("os.arch"))
            ?: throw NodeFetchException("unsupported platform: ${System.getProperty("os.name")} ${System.getProperty("os.arch")}")
        cached(cacheDir, key)?.let { return it to false }
        NodeLocator.onPath(pathEnv, probe = probe)?.let { return it to false }
        val t = target() ?: throw NodeFetchException("no Node $VERSION archive for $key")
        onProgress("Downloading Node $VERSION")
        val node = fetch(
            t,
            cacheDir,
            { d, tot -> onProgress("Downloading Node $VERSION (${d / 1024 / 1024} MB of ${tot / 1024 / 1024} MB)") },
            canceled,
        )
        return node to true
    }

    /**
     * Ensure [cacheDir] holds a node binary for [t]: fetch SHASUMS256.txt and
     * [t.archive] from [base]/, verify the checksum, extract the node member
     * into a temp dir and move it to <cacheDir>/<os-key>/ atomically. Existing
     * cache copies short-circuit without any network use. [canceled] is polled
     * before each network operation and per read chunk so a user cancel aborts
     * mid-download with [NodeFetchException].
     */
    fun fetch(
        t: NodeTarget,
        cacheDir: File,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
        base: String = DEFAULT_BASE_URL,
        canceled: () -> Boolean = { false },
        fetchBytes: (String, (Long, Long) -> Unit, () -> Boolean) -> ByteArray = ::downloadBytes,
    ): File {
        val outDir = File(cacheDir, t.osKey)
        val out = File(outDir, t.exe)
        if (out.isFile) return out
        outDir.parentFile?.mkdirs()
        val shasums = fetchBytes("$base/SHASUMS256.txt", { _, _ -> }, canceled).toString(Charsets.UTF_8)
        if (canceled()) throw NodeFetchException("download cancelled")
        val sha = shasumFor(shasums, t.archive)
            ?: throw NodeFetchException("no SHASUMS256 entry for ${t.archive}")
        val bytes = fetchBytes("$base/${t.archive}", onProgress, canceled)
        val actual = sha256Hex(bytes)
        if (!constantTimeEquals(sha.lowercase(), actual)) {
            throw NodeFetchException("sha256 mismatch for ${t.archive}: expected $sha, got $actual")
        }
        val tmp = File(outDir.parentFile ?: cacheDir, "${t.osKey}.${randomSuffix()}.tmp")
        try {
            extract(bytes, t.archive, t.member, t.exe, bytes.size.toLong(), tmp, onProgress)
            val bin = File(tmp, t.exe)
            if (!bin.isFile) throw NodeFetchException("${t.archive} did not contain ${t.member}")
            bin.setExecutable(true, true)
            moveInto(bin, tmp, outDir, t.exe)
            return out
        } finally {
            tmp.deleteRecursively()
        }
    }

    /** SHA-256 hex of [bytes]. */
    fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }

    fun sha256Hex(stream: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(CHUNK)
        while (true) {
            val n = stream.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** SHA-256 entry for [filename] in a SHASUMS256.txt body (optional leading '*' marker). */
    fun shasumFor(shasumsText: String, filename: String): String? {
        for (line in shasumsText.lineSequence()) {
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size < 2) continue
            val hash = parts[0].lowercase()
            if (hash.length != 64 || hash.any { it !in "0123456789abcdef" }) continue
            if (parts[1].removePrefix("*") == filename) return hash
        }
        return null
    }

    /** Download [url] (redirects followed, 15 s connect / 30 s read, 150 MB cap), reporting byte progress. */
    fun downloadBytes(url: String, onProgress: (Long, Long) -> Unit = { _, _ -> }, canceled: () -> Boolean = { false }): ByteArray {
        val conn = URI(url).toURL().openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = true
        return try {
            val code = conn.responseCode
            if (code != 200) throw NodeFetchException("$url: HTTP $code")
            if (canceled()) throw NodeFetchException("download cancelled")
            val total = conn.contentLength.toLong()
            conn.inputStream.use { stream ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(64 * 1024)
                var done = 0L
                var lastReport = 0L
                while (true) {
                    if (canceled()) throw NodeFetchException("download cancelled")
                    val n = stream.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    if (done > ARCHIVE_CAP) throw NodeFetchException("archive too large: $url")
                    if (done - lastReport >= 512L * 1024 || done == total) {
                        lastReport = done
                        onProgress(done, total)
                    }
                }
                out.toByteArray()
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun extract(bytes: ByteArray, archive: String, memberPath: String, exe: String, total: Long, tmp: File, onProgress: (Long, Long) -> Unit) {
        tmp.mkdirs()
        var out: OutputStream? = null
        try {
            if (archive.endsWith(".zip")) {
                ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        if (!entry.isDirectory && entry.name == memberPath) {
                            out = writeMember(zip, exe, tmp, total, onProgress)
                        }
                        entry = zip.nextEntry
                    }
                }
            } else {
                GZIPInputStream(ByteArrayInputStream(bytes)).use { gz ->
                    TarArchiveInputStream(gz).use { tar ->
                        var entry: TarArchiveEntry? = tar.nextEntry
                        while (entry != null) {
                            if (!entry.isDirectory && entry.name == memberPath) {
                                out = writeMember(tar, exe, tmp, total, onProgress)
                            }
                            entry = tar.nextEntry
                        }
                    }
                }
            }
        } finally {
            out?.close()
        }
    }

    private fun writeMember(stream: InputStream, exe: String, tmp: File, total: Long, onProgress: (Long, Long) -> Unit): OutputStream =
        FileOutputStream(File(tmp, exe)).also { os ->
            val buf = ByteArray(CHUNK)
            var done = 0L
            while (true) {
                val n = stream.read(buf)
                if (n < 0) break
                os.write(buf, 0, n)
                done += n
                onProgress(done, total)
            }
        }

    /** Install [bin] (extracted in [tmp]) as <[outDir]>/<[exe]>, replacing any stale cache dir. */
    private fun moveInto(bin: File, tmp: File, outDir: File, exe: String) {
        if (outDir.exists() && !outDir.deleteRecursively()) throw NodeFetchException("cannot replace ${outDir.path}")
        if (!tmp.renameTo(outDir)) {
            // Cross-filesystem (or otherwise failed) rename: copy the binary into a fresh dir.
            outDir.mkdirs()
            bin.copyTo(File(outDir, exe))
        }
    }

    /** Constant-time string compare (no early exit on a mismatch prefix). */
    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        return MessageDigest.isEqual(m.doFinal(a.toByteArray()), m.doFinal(b.toByteArray()))
    }

    private fun randomSuffix(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(java.security.SecureRandom().generateSeed(8))
}

/** Actionable message for "no usable Node 22": download via the tool window, or install one yourself. */
fun nodeStewartError(): String =
    """No Node.js 22+ found. Stewart can download and cache Node ${NodeFetcher.VERSION} from nodejs.org — open the Stewart tool window and press Restart to self-install, or install Node 22+ yourself (https://nodejs.org) and restart the IDE. The per-OS Stewart plugin zips also bundle a Node runtime."""

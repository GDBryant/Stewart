package com.adb.stewart.ui

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.chat.ImageLimits
import com.adb.stewart.chat.ImageLoader
import java.awt.Image
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.awt.datatransfer.UnsupportedFlavorException
import java.awt.event.InputEvent
import java.net.URI
import java.nio.file.Path
import javax.swing.JComponent
import javax.swing.TransferHandler

/**
 * Turns pasted images and dropped image files into attachments; everything else (normal text
 * paste, cut/copy, text drops) is delegated unchanged to [fallback].
 */
class ImageTransferHandler(
    private val onImage: (ImageAttachment) -> Unit,
    private val onError: (String) -> Unit,
    private val fallback: TransferHandler,
) : TransferHandler() {

    companion object {
        /** Wayland and some file managers offer dropped files only as `text/uri-list`. */
        val URI_LIST = DataFlavor("text/uri-list;class=java.lang.String")

        fun isImageName(name: String): Boolean = name.substringAfterLast('.', "").lowercase() in ImageLimits.EXTENSIONS

        /** Local file paths in a `text/uri-list` payload; comments and non-file URIs are skipped. */
        fun parseUriList(text: String): List<Path> = text.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .mapNotNull { runCatching { Path.of(URI(it)) }.getOrNull() }
            .toList()
    }

    private fun files(t: Transferable): List<Path> {
        if (t.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
            val list = runCatching { t.getTransferData(DataFlavor.javaFileListFlavor) as? List<*> }.getOrNull()
            return list.orEmpty().filterIsInstance<java.io.File>().map { it.toPath() }
        }
        if (t.isDataFlavorSupported(URI_LIST)) {
            val text = runCatching { t.getTransferData(URI_LIST) as? String }.getOrNull().orEmpty()
            return parseUriList(text)
        }
        return emptyList()
    }

    /** An image-only clipboard; rich copies (image plus text) are normal text pastes. */
    private fun pastedImage(t: Transferable): Boolean =
        t.isDataFlavorSupported(DataFlavor.imageFlavor) && !t.isDataFlavorSupported(DataFlavor.stringFlavor)

    private fun hasImage(t: Transferable): Boolean =
        pastedImage(t) || files(t).any { isImageName(it.fileName?.toString().orEmpty()) }

    override fun canImport(support: TransferSupport): Boolean =
        hasImage(support.transferable) || fallback.canImport(support)

    override fun canImport(comp: JComponent, transferFlavors: Array<DataFlavor>): Boolean =
        (DataFlavor.imageFlavor in transferFlavors && DataFlavor.stringFlavor !in transferFlavors) || fallback.canImport(comp, transferFlavors)

    override fun importData(comp: JComponent, t: Transferable): Boolean = importData(TransferSupport(comp, t))

    override fun importData(support: TransferSupport): Boolean {
        val t = support.transferable
        val paths = files(t)
        if (paths.any { isImageName(it.fileName?.toString().orEmpty()) }) {
            val errors = mutableListOf<String>()
            for (p in paths) {
                val name = p.fileName?.toString().orEmpty()
                if (!isImageName(name)) {
                    errors += "Not an image: $name"
                    continue
                }
                ImageLoader.fromFile(p).fold(onImage) { errors += it.message ?: "Could not read $name" }
            }
            if (errors.isNotEmpty()) onError(errors.joinToString("; "))
            return true
        }
        if (pastedImage(t)) {
            try {
                val img = t.getTransferData(DataFlavor.imageFlavor) as Image
                onImage(ImageLoader.fromImage(img))
            } catch (e: UnsupportedFlavorException) {
                onError("Could not read the pasted image")
            } catch (e: java.io.IOException) {
                onError("Could not read the pasted image")
            } catch (e: IllegalArgumentException) {
                onError(e.message ?: "Could not read the pasted image")
            }
            return true
        }
        return fallback.importData(support)
    }

    override fun getSourceActions(c: JComponent): Int = fallback.getSourceActions(c)

    override fun exportToClipboard(comp: JComponent, clip: java.awt.datatransfer.Clipboard, action: Int) =
        fallback.exportToClipboard(comp, clip, action)

    override fun exportAsDrag(comp: JComponent, e: InputEvent, action: Int) =
        fallback.exportAsDrag(comp, e, action)
}

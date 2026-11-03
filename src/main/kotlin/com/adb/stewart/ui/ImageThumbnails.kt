package com.adb.stewart.ui

import com.adb.stewart.chat.ImageAttachment
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import java.awt.BorderLayout
import java.awt.Image
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import javax.imageio.ImageIO
import javax.swing.Icon
import javax.swing.ImageIcon
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JScrollPane

object ImageThumbnails {
    const val CHAT_MAX = 160
    const val STRIP_MAX = 48

    fun decode(a: ImageAttachment): BufferedImage? = runCatching { ImageIO.read(ByteArrayInputStream(a.bytes)) }.getOrNull()

    /** [a] scaled so its longest edge is at most [max] (never enlarged); null when it cannot be decoded. */
    fun scaled(a: ImageAttachment, max: Int): BufferedImage? {
        val src = decode(a) ?: return null
        val edge = maxOf(src.width, src.height)
        if (edge <= max) return src
        val s = max.toDouble() / edge
        val w = maxOf(1, Math.round(src.width * s).toInt())
        val h = maxOf(1, Math.round(src.height * s).toInt())
        val dst = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
        dst.createGraphics().apply {
            setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            drawImage(src, 0, 0, w, h, null)
            dispose()
        }
        return dst
    }

    fun icon(a: ImageAttachment, max: Int): Icon? = scaled(a, max)?.let { ImageIcon(it as Image) }

    /** Thumbnail label; clicking opens the full-size image when [project] is given. */
    fun label(a: ImageAttachment, max: Int, project: Project? = null): JLabel {
        val l = JLabel()
        l.icon = icon(a, max)
        if (l.icon == null) l.text = a.name
        l.name = "thumbnail"
        l.toolTipText = a.name
        if (project != null) {
            l.cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            l.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) = showFull(project, a)
            })
        }
        return l
    }

    fun showFull(project: Project, a: ImageAttachment) {
        val full = icon(a, Int.MAX_VALUE) ?: return
        object : DialogWrapper(project, false) {
            init {
                title = a.name
                init()
            }

            override fun createCenterPanel(): JComponent = JScrollPane(JLabel(full)).also {
                it.preferredSize = java.awt.Dimension(
                    minOf(full.iconWidth + 20, 1000),
                    minOf(full.iconHeight + 20, 800),
                )
            }

            override fun createActions() = arrayOf(okAction)
        }.show()
    }
}

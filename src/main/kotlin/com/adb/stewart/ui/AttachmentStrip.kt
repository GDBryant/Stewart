package com.adb.stewart.ui

import com.adb.stewart.chat.ImageAttachment
import com.intellij.util.ui.JBUI
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel

/** Row of pending image attachments (thumbnail, name, remove button) shown above the input. */
class AttachmentStrip(private val onRemove: (Int) -> Unit) : JPanel(FlowLayout(FlowLayout.LEFT, 6, 2)) {

    internal val removeButtons: List<JButton>
        get() = components.filterIsInstance<JPanel>().flatMap { it.components.filterIsInstance<JButton>() }

    internal val names: List<String>
        get() = components.filterIsInstance<JPanel>().mapNotNull { p ->
            p.components.filterIsInstance<JLabel>().firstOrNull { it.name == "attachment-name" }?.text
        }

    init {
        isVisible = false
    }

    fun show(images: List<ImageAttachment>) {
        removeAll()
        images.forEachIndexed { i, a ->
            val item = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
            item.isOpaque = false
            item.add(ImageThumbnails.label(a, ImageThumbnails.STRIP_MAX))
            item.add(JLabel(a.name).also { it.name = "attachment-name" })
            item.add(JButton("✕").also {
                it.toolTipText = "Remove ${a.name}"
                it.margin = JBUI.insets(0, 4)
                it.isFocusable = false
                it.addActionListener { onRemove(i) }
            })
            add(item)
        }
        isVisible = images.isNotEmpty()
        revalidate()
        repaint()
    }
}

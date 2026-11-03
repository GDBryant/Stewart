package com.adb.stewart

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.ui.ImageTransferHandler
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.datatransfer.Transferable
import java.awt.image.BufferedImage
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import javax.imageio.ImageIO
import javax.swing.JTextArea
import javax.swing.TransferHandler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageTransferHandlerTest {

    private val images = mutableListOf<ImageAttachment>()
    private val errors = mutableListOf<String>()
    private val area = JTextArea()
    private val handler = ImageTransferHandler({ images += it }, { errors += it }, area.transferHandler)

    private fun png(dir: Path, name: String, size: Int = 4): File {
        val f = dir.resolve(name).toFile()
        ImageIO.write(BufferedImage(size, size, BufferedImage.TYPE_INT_RGB), "png", f)
        return f
    }

    private class Fake(val flavor: DataFlavor, val data: Any) : Transferable {
        override fun getTransferDataFlavors() = arrayOf(flavor)
        override fun isDataFlavorSupported(f: DataFlavor) = f == flavor
        override fun getTransferData(f: DataFlavor): Any = data
    }

    private fun files(vararg f: File) = Fake(DataFlavor.javaFileListFlavor, f.toList())

    @Test
    fun `pasted image attaches`() {
        val t = Fake(DataFlavor.imageFlavor, BufferedImage(6, 6, BufferedImage.TYPE_INT_RGB))
        assertTrue(handler.canImport(TransferHandler.TransferSupport(area, t)))
        assertTrue(handler.importData(area, t))
        assertEquals(1, images.size)
        assertEquals("image/png", images[0].mediaType)
        assertTrue(errors.isEmpty())
    }

    @Test
    fun `pasted plain text goes to the fallback and attaches nothing`() {
        val t = StringSelection("hello")
        assertTrue(handler.canImport(TransferHandler.TransferSupport(area, t)))
        assertTrue(handler.importData(area, t))
        assertEquals("hello", area.text)
        assertTrue(images.isEmpty())
        assertTrue(errors.isEmpty())
    }

    @Test
    fun `dropped png and txt attach only the png and report the txt`() {
        val dir = Files.createTempDirectory("drop")
        val txt = File(dir.toFile(), "b.txt").also { it.writeText("x") }
        assertTrue(handler.importData(area, files(png(dir, "a.png"), txt)))
        assertEquals(listOf("a.png"), images.map { it.name })
        assertEquals(1, errors.size)
        assertTrue(errors[0].contains("b.txt"))
    }

    @Test
    fun `dropped txt only is not accepted`() {
        val dir = Files.createTempDirectory("drop")
        val txt = File(dir.toFile(), "b.txt").also { it.writeText("x") }
        assertFalse(handler.canImport(TransferHandler.TransferSupport(area, files(txt))))
        assertTrue(images.isEmpty())
    }

    @Test
    fun `corrupt image file reports an error`() {
        val dir = Files.createTempDirectory("drop")
        val bad = File(dir.toFile(), "bad.png").also { it.writeText("not a png") }
        handler.importData(area, files(bad))
        assertTrue(images.isEmpty())
        assertTrue(errors.single().contains("Could not decode"))
    }

    @Test
    fun `oversize image is rejected`() {
        val dir = Files.createTempDirectory("drop")
        val big = BufferedImage(1500, 1500, BufferedImage.TYPE_INT_ARGB)
        val rnd = java.util.Random(1)
        for (y in 0 until 1500) for (x in 0 until 1500) big.setRGB(x, y, rnd.nextInt())
        val f = File(dir.toFile(), "big.png")
        ImageIO.write(big, "png", f)
        handler.importData(area, files(f))
        assertTrue(images.isEmpty())
        assertTrue(errors.single().contains("too large"))
    }

    @Test
    fun `uri list drop attaches the file and skips comments`() {
        val dir = Files.createTempDirectory("drop")
        val f = png(dir, "w.png")
        val t = Fake(ImageTransferHandler.URI_LIST, "# comment\n${f.toURI()}\nhttp://example.com/x.png\n")
        assertTrue(handler.canImport(TransferHandler.TransferSupport(area, t)))
        handler.importData(area, t)
        assertEquals(listOf("w.png"), images.map { it.name })
    }

    @Test
    fun `parseUriList ignores blanks and non-file uris`() {
        assertTrue(ImageTransferHandler.parseUriList("\n  \n#x\nhttp://a/b.png\n::bad").isEmpty())
    }

    @Test
    fun `flavor based canImport accepts images and delegates the rest`() {
        assertTrue(handler.canImport(area, arrayOf(DataFlavor.imageFlavor)))
        assertTrue(handler.canImport(area, arrayOf(DataFlavor.stringFlavor)))
        assertFalse(handler.canImport(area, arrayOf(DataFlavor.javaFileListFlavor)))
    }

    @Test
    fun `source actions delegate to the fallback`() {
        assertEquals(area.transferHandler.getSourceActions(area), handler.getSourceActions(area))
    }

    @Test
    fun `copy delegates to the fallback`() {
        area.text = "copyme"
        area.selectAll()
        val clip = java.awt.datatransfer.Clipboard("t")
        handler.exportToClipboard(area, clip, TransferHandler.COPY)
        assertEquals("copyme", clip.getData(DataFlavor.stringFlavor))
    }
}

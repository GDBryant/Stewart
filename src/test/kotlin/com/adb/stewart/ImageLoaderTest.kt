package com.adb.stewart

import com.adb.stewart.chat.ImageAttachment
import com.adb.stewart.chat.ImageLimits
import com.adb.stewart.chat.ImageLoader
import com.adb.stewart.provider.ChatMessage
import com.adb.stewart.provider.Role
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Random
import javax.imageio.ImageIO

class ImageLoaderTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun png(w: Int, h: Int, noise: Boolean = false): ByteArray {
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        if (noise) {
            val r = Random(1)
            for (y in 0 until h) for (x in 0 until w) img.setRGB(x, y, r.nextInt())
        }
        return ByteArrayOutputStream().also { ImageIO.write(img, "png", it) }.toByteArray()
    }

    @Test fun validPngLoads() {
        val f = tmp.newFile("a.png").apply { writeBytes(png(10, 10)) }.toPath()
        val a = ImageLoader.fromFile(f).getOrThrow()
        assertEquals("image/png", a.mediaType)
        assertEquals("a.png", a.name)
        assertTrue(a.dataUrl().startsWith("data:image/png;base64,"))
        assertEquals(a.base64(), a.dataUrl().substringAfter(","))
    }

    @Test fun txtRejected() {
        val f = tmp.newFile("a.txt").apply { writeText("hi") }.toPath()
        val r = ImageLoader.fromFile(f)
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("Unsupported"))
    }

    @Test fun nonImageBytesWithPngExtRejected() {
        val f = tmp.newFile("b.png").apply { writeText("not an image") }.toPath()
        val r = ImageLoader.fromFile(f)
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("decode"))
    }

    @Test fun missingFileFails() {
        val r = ImageLoader.fromFile(tmp.root.toPath().resolve("nope.png"))
        assertTrue(r.isFailure)
    }

    @Test fun oversizeRejectedAfterNormalize() {
        val bytes = png(1500, 1500, noise = true)
        assertTrue(bytes.size > ImageLimits.MAX_BYTES)
        val f = tmp.newFile("big.png").apply { writeBytes(bytes) }.toPath()
        val r = ImageLoader.fromFile(f)
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("too large"))
    }

    @Test fun largeImageDownscaled() {
        val f = tmp.newFile("c.png").apply { writeBytes(png(4000, 3000)) }.toPath()
        val a = ImageLoader.fromFile(f).getOrThrow()
        val img = ImageIO.read(ByteArrayInputStream(a.bytes))
        assertEquals(ImageLimits.MAX_EDGE, img.width)
        assertEquals(1176, img.height)
        assertEquals("image/png", a.mediaType)
    }

    @Test fun smallImageUnchanged() {
        val a = ImageAttachment("image/png", png(20, 10), "s.png")
        assertTrue(ImageLoader.normalize(a) === a)
    }

    @Test fun fromImageYieldsPng() {
        val a = ImageLoader.fromImage(BufferedImage(8, 6, BufferedImage.TYPE_INT_ARGB))
        assertEquals("pasted.png", a.name)
        assertEquals("image/png", a.mediaType)
        val img = ImageIO.read(ByteArrayInputStream(a.bytes))
        assertNotNull(img)
        assertEquals(8, img.width)
    }

    @Test fun equalsUsesContent() {
        val a = ImageAttachment("image/png", byteArrayOf(1, 2), "x")
        val b = ImageAttachment("image/png", byteArrayOf(1, 2), "x")
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        assertNotEquals(a, ImageAttachment("image/png", byteArrayOf(1, 3), "x"))
        assertNotEquals(a, "x")
    }

    @Test fun chatMessageImagesDefaultEmpty() {
        assertTrue(ChatMessage(Role.USER, "hi").images.isEmpty())
        val a = ImageAttachment("image/png", byteArrayOf(1), "x")
        assertArrayEquals(byteArrayOf(1), ChatMessage(Role.USER, "hi", images = listOf(a)).images[0].bytes)
    }

    private fun jpg(): ByteArray =
        ByteArrayOutputStream().also { ImageIO.write(BufferedImage(10, 10, BufferedImage.TYPE_INT_RGB), "jpg", it) }.toByteArray()

    @Test fun jpgAndJpegMapToImageJpeg() {
        for (n in listOf("a.jpg", "b.JPEG")) {
            val f = tmp.newFile(n).apply { writeBytes(jpg()) }.toPath()
            assertEquals("image/jpeg", ImageLoader.fromFile(f).getOrThrow().mediaType)
        }
    }

    @Test fun gifMapsToImageGif() {
        val o = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(5, 5, BufferedImage.TYPE_INT_RGB), "gif", o)
        val f = tmp.newFile("g.gif").apply { writeBytes(o.toByteArray()) }.toPath()
        assertEquals("image/gif", ImageLoader.fromFile(f).getOrThrow().mediaType)
    }

    @Test fun webpUndecodableGivesHint() {
        val f = tmp.newFile("w.webp").apply { writeText("junk") }.toPath()
        val r = ImageLoader.fromFile(f)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("webp may be unsupported"))
    }

    @Test fun nonWebpDecodeFailureHasNoWebpHint() {
        val f = tmp.newFile("j.png").apply { writeText("junk") }.toPath()
        assertTrue(!ImageLoader.fromFile(f).exceptionOrNull()!!.message!!.contains("webp"))
    }

    @Test fun directoryRejected() {
        val d = tmp.newFolder("dir.png").toPath()
        val r = ImageLoader.fromFile(d)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("not found"))
    }

    @Test fun readCapRejectsBigFileButAllowsWithinCap() {
        val f = tmp.newFile("cap.png").apply { writeBytes(png(10, 10)) }.toPath()
        val r = ImageLoader.fromFile(f, maxReadBytes = 10)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("too large"))
        assertTrue(ImageLoader.fromFile(f, maxReadBytes = 1_000_000).isSuccess)
    }

    @Test fun fromImageNonBufferedImage() {
        val src = BufferedImage(7, 5, BufferedImage.TYPE_INT_RGB)
        val scaled = src.getScaledInstance(7, 5, java.awt.Image.SCALE_DEFAULT)
        assertTrue(scaled !is BufferedImage)
        val a = ImageLoader.fromImage(scaled)
        assertTrue(a.bytes.isNotEmpty())
        assertEquals(7, ImageIO.read(ByteArrayInputStream(a.bytes)).width)
    }

    @Test fun fromImageZeroSizeRejected() {
        val e = org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            ImageLoader.fromImage(object : java.awt.Image() {
                override fun getWidth(o: java.awt.image.ImageObserver?) = 0
                override fun getHeight(o: java.awt.image.ImageObserver?) = 0
                override fun getSource(): java.awt.image.ImageProducer? = null
                override fun getGraphics(): java.awt.Graphics? = null
                override fun getProperty(n: String?, o: java.awt.image.ImageObserver?): Any? = null
            })
        }
        assertTrue(e.message!!.contains("no size"))
    }
}

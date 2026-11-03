package com.adb.stewart.chat

import java.awt.Image
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import javax.imageio.ImageIO

object ImageLoader {
    private const val HARD_READ_CAP = 50L * 1024 * 1024

    fun fromFile(path: Path): Result<ImageAttachment> = runCatching {
        val name = path.fileName?.toString() ?: path.toString()
        val ext = name.substringAfterLast('.', "").lowercase()
        require(ext in ImageLimits.EXTENSIONS) {
            "Unsupported image type '.$ext' (use ${ImageLimits.EXTENSIONS.joinToString(", ")})"
        }
        require(Files.isRegularFile(path)) { "File not found: $name" }
        require(Files.size(path) <= HARD_READ_CAP) { "Image too large: $name" }
        val bytes = Files.readAllBytes(path)
        val mime = when (ext) {
            "jpg", "jpeg" -> "image/jpeg"
            else -> "image/$ext"
        }
        normalize(ImageAttachment(mime, bytes, name))
    }

    fun fromImage(img: Image, name: String = "pasted.png"): ImageAttachment {
        val w = img.getWidth(null)
        val h = img.getHeight(null)
        require(w > 0 && h > 0) { "Image has no size" }
        val buf = if (img is BufferedImage) img else BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB).also {
            it.createGraphics().apply { drawImage(img, 0, 0, null); dispose() }
        }
        return normalize(ImageAttachment("image/png", encodePng(buf), name))
    }

    /** Downscales to [ImageLimits.MAX_EDGE]; throws IllegalArgumentException if undecodable or still over [ImageLimits.MAX_BYTES]. */
    fun normalize(a: ImageAttachment): ImageAttachment {
        val src = runCatching { ImageIO.read(ByteArrayInputStream(a.bytes)) }.getOrNull()
            ?: throw IllegalArgumentException("Could not decode image: ${a.name}")
        val edge = maxOf(src.width, src.height)
        val out = if (edge <= ImageLimits.MAX_EDGE) a else {
            val s = ImageLimits.MAX_EDGE.toDouble() / edge
            val w = maxOf(1, Math.round(src.width * s).toInt())
            val h = maxOf(1, Math.round(src.height * s).toInt())
            val dst = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
            dst.createGraphics().apply {
                setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR)
                drawImage(src, 0, 0, w, h, null)
                dispose()
            }
            ImageAttachment("image/png", encodePng(dst), a.name)
        }
        require(out.bytes.size <= ImageLimits.MAX_BYTES) {
            "Image too large: ${a.name} is ${out.bytes.size / 1000} KB (max ${ImageLimits.MAX_BYTES / 1000} KB)"
        }
        return out
    }

    private fun encodePng(img: BufferedImage): ByteArray {
        val o = ByteArrayOutputStream()
        require(ImageIO.write(img, "png", o)) { "Could not encode PNG" }
        return o.toByteArray()
    }
}

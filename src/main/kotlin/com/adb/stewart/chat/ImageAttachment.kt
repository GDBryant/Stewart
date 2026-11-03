package com.adb.stewart.chat

import java.util.Base64

data class ImageAttachment(val mediaType: String, val bytes: ByteArray, val name: String) {
    fun base64(): String = Base64.getEncoder().encodeToString(bytes)

    fun dataUrl(): String = "data:$mediaType;base64,${base64()}"

    override fun equals(other: Any?): Boolean =
        other is ImageAttachment && mediaType == other.mediaType && name == other.name && bytes.contentEquals(other.bytes)

    override fun hashCode(): Int = 31 * (31 * mediaType.hashCode() + name.hashCode()) + bytes.contentHashCode()

    /** Short log-safe stand-in for the payload, e.g. `[image png 123KB]`. */
    fun placeholder(): String =
        "[image ${mediaType.substringAfter('/')} ${maxOf(1, (bytes.size + 1023) / 1024)}KB]"
}

/** Replaces every attachment's base64 payload in [text] with its placeholder, for debug logs. */
fun redactImages(text: String, images: List<ImageAttachment>): String =
    images.fold(text) { acc, img -> acc.replace(img.base64(), img.placeholder()) }

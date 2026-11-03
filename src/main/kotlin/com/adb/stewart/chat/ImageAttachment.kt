package com.adb.stewart.chat

import java.util.Base64

data class ImageAttachment(val mediaType: String, val bytes: ByteArray, val name: String) {
    fun base64(): String = Base64.getEncoder().encodeToString(bytes)

    fun dataUrl(): String = "data:$mediaType;base64,${base64()}"

    override fun equals(other: Any?): Boolean =
        other is ImageAttachment && mediaType == other.mediaType && name == other.name && bytes.contentEquals(other.bytes)

    override fun hashCode(): Int = 31 * (31 * mediaType.hashCode() + name.hashCode()) + bytes.contentHashCode()
}

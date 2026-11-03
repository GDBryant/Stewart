package com.adb.stewart.settings

import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.provider.ToolPath

object ToolPathResolver {
    val NATIVE_CAPABLE: Set<String> = setOf("aif", "ollama")

    fun resolve(ref: ModelRef, provider: ModelProvider, overrides: Map<String, String>): ToolPath {
        overrides[ref.encode()]?.let {
            if (it.equals("NATIVE", ignoreCase = true) && ref.providerId in NATIVE_CAPABLE) {
                return ToolPath.NATIVE
            }
            if (!it.equals("NATIVE", ignoreCase = true)) return ToolPath.SHIM
        }
        return if (provider.supportsNativeTools(ref.modelId)) ToolPath.NATIVE else ToolPath.SHIM
    }
}

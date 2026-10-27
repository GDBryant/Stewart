package com.aijb.assistant.settings

import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ToolPath

object ToolPathResolver {
    val NATIVE_CAPABLE: Set<String> = setOf("aif")

    fun resolve(ref: ModelRef, provider: ModelProvider, overrides: Map<String, String>): ToolPath {
        overrides[ref.encode()]?.let {
            return if (it.equals("NATIVE", ignoreCase = true)) ToolPath.NATIVE else ToolPath.SHIM
        }
        return if (provider.supportsNativeTools(ref.modelId)) ToolPath.NATIVE else ToolPath.SHIM
    }
}

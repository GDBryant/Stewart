package com.adb.stewart.agents

import com.adb.stewart.chat.ImageStrippingProvider
import com.adb.stewart.provider.ModelProvider
import com.adb.stewart.provider.ModelRef
import com.adb.stewart.settings.ToolPathResolver
import com.adb.stewart.shim.ToolCallingProvider

/** Where one level's requests go: the model id, the (shim-wrapped) provider and a display label. */
data class LevelRoute(val ref: ModelRef, val provider: ModelProvider) {
    val label: String get() = ref.encode()
}

sealed interface RoutingResult {
    data class Resolved(val routes: Map<AgentRole, LevelRoute>) : RoutingResult
    data class Unresolved(val message: String) : RoutingResult
}

/**
 * Binds each role to its configured ModelRef (M7). Every role must be set: a disabled selector
 * must never influence a run, so there is no fallback to the single-model picker. A configured
 * ref whose provider is missing is an error too: a role is never silently moved to a different
 * provider (e.g. local Ollama to a remote one).
 */
object RoleRouting {
    fun resolve(
        configured: Map<AgentRole, ModelRef?>,
        providers: List<ModelProvider>,
        toolPathOverrides: Map<String, String>,
    ): RoutingResult {
        val routes = mutableMapOf<AgentRole, LevelRoute>()
        for (role in AgentRole.entries) {
            val ref = configured[role]
                ?: return RoutingResult.Unresolved("No model selected for ${role.name.lowercase()}")
            routes[role] = routeFor(ref, providers, toolPathOverrides)
                ?: return RoutingResult.Unresolved(
                    "Provider not configured for ${role.name.lowercase()}: ${ref.providerId}"
                )
        }
        return RoutingResult.Resolved(routes)
    }

    /** Route for one ref (shim-wrapped per its tool path), or null if its provider is missing. */
    fun routeFor(
        ref: ModelRef,
        providers: List<ModelProvider>,
        toolPathOverrides: Map<String, String>,
    ): LevelRoute? {
        val provider = providers.firstOrNull { it.id == ref.providerId } ?: return null
        val path = ToolPathResolver.resolve(ref, provider, toolPathOverrides)
        return LevelRoute(ref, ToolCallingProvider(ImageStrippingProvider(provider), path))
    }

    /** Every level bound to the same route. */
    fun uniform(route: LevelRoute): Map<AgentRole, LevelRoute> =
        AgentRole.entries.associateWith { route }
}

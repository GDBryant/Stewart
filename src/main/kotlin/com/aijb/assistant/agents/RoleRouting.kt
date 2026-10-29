package com.aijb.assistant.agents

import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.settings.ToolPathResolver
import com.aijb.assistant.shim.ToolCallingProvider

/** Where one level's requests go: the model id, the (shim-wrapped) provider and a display label. */
data class LevelRoute(val ref: ModelRef, val provider: ModelProvider) {
    val label: String get() = ref.encode()
}

sealed interface RoutingResult {
    data class Resolved(val routes: Map<AgentRole, LevelRoute>) : RoutingResult
    data class Unresolved(val message: String) : RoutingResult
}

/**
 * Binds each role to its configured ModelRef (M7). An unset role uses the chat-picker
 * selection. A configured ref whose provider is missing is an error: a role is never
 * silently moved to a different provider (e.g. local Ollama to a remote one).
 */
object RoleRouting {
    fun resolve(
        chatRef: ModelRef?,
        configured: Map<AgentRole, ModelRef?>,
        providers: List<ModelProvider>,
        toolPathOverrides: Map<String, String>,
    ): RoutingResult {
        val routes = mutableMapOf<AgentRole, LevelRoute>()
        for (role in AgentRole.entries) {
            val ref = configured[role] ?: chatRef
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
        return LevelRoute(ref, ToolCallingProvider(provider, path))
    }

    /** Every level bound to the same route. */
    fun uniform(route: LevelRoute): Map<AgentRole, LevelRoute> =
        AgentRole.entries.associateWith { route }
}

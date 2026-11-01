package com.aijb.assistant

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.agents.LevelRoute
import com.aijb.assistant.agents.RoleRouting
import com.aijb.assistant.agents.RoutingResult
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.ProviderEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RoleRoutingTest {
    private fun provider(pid: String) = object : ModelProvider {
        override val id = pid
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = emptyFlow()
    }

    private val chat = ModelRef("ollama", "q")
    private val providers = listOf(provider("ollama"), provider("claude"))

    @Test
    fun `each role resolves to its configured ref`() {
        val r = RoleRouting.resolve(
            mapOf(
                AgentRole.PLANNER to ModelRef("claude", "opus"),
                AgentRole.EXECUTOR to ModelRef("ollama", "mid"),
                AgentRole.WORKER to ModelRef("ollama", "tiny"),
            ),
            providers, emptyMap(),
        ) as RoutingResult.Resolved
        assertEquals(
            listOf("claude/opus", "ollama/mid", "ollama/tiny"),
            AgentRole.entries.map { r.routes.getValue(it).label },
        )
    }

    @Test
    fun `an unset role is an error not a fallback`() {
        val r = RoleRouting.resolve(
            mapOf(AgentRole.PLANNER to ModelRef("claude", "opus"), AgentRole.EXECUTOR to ModelRef("ollama", "mid")),
            providers, emptyMap(),
        )
        assertEquals(RoutingResult.Unresolved("No model selected for worker"), r)
    }

    @Test
    fun `missing provider is an error not a fallback`() {
        val r = RoleRouting.resolve(
            mapOf(
                AgentRole.PLANNER to ModelRef("claude", "opus"),
                AgentRole.EXECUTOR to ModelRef("claude", "opus"),
                AgentRole.WORKER to ModelRef("aif", "m"),
            ),
            providers, emptyMap(),
        )
        assertEquals(
            RoutingResult.Unresolved("Provider not configured for worker: aif"),
            r,
        )
    }

    @Test
    fun `nothing configured reports the first role`() {
        val r = RoleRouting.resolve(emptyMap(), providers, emptyMap())
        assertEquals(RoutingResult.Unresolved("No model selected for planner"), r)
    }

    @Test
    fun `all roles on one model resolves`() {
        val r = RoleRouting.resolve(
            AgentRole.entries.associateWith { ModelRef("claude", "opus") },
            providers, emptyMap(),
        )
        assertTrue(r is RoutingResult.Resolved)
    }

    @Test
    fun `routeFor wraps the matching provider`() {
        val route = RoleRouting.routeFor(ModelRef("claude", "opus"), providers, emptyMap())!!
        assertEquals("claude/opus", route.label)
        assertEquals("claude", route.provider.id)
        assertTrue(route.provider is com.aijb.assistant.shim.ToolCallingProvider)
    }

    @Test
    fun `routeFor returns null for a missing provider`() {
        assertNull(RoleRouting.routeFor(ModelRef("aif", "m"), providers, emptyMap()))
    }

    @Test
    fun `uniform binds every role to the same route`() {
        val route = LevelRoute(chat, providers[0])
        val routes = RoleRouting.uniform(route)
        assertEquals(AgentRole.entries.toSet(), routes.keys)
        assertTrue(routes.values.all { it === route })
        assertSame(route, routes[AgentRole.WORKER])
    }
}

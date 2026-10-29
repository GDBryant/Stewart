package com.aijb.assistant

import com.aijb.assistant.agents.AgentRole
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
            chat,
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
    fun `unset roles use the chat selection`() {
        val r = RoleRouting.resolve(chat, emptyMap(), providers, emptyMap()) as RoutingResult.Resolved
        assertTrue(AgentRole.entries.all { r.routes.getValue(it).label == "ollama/q" })
    }

    @Test
    fun `missing provider is an error not a fallback`() {
        val r = RoleRouting.resolve(
            chat,
            mapOf(AgentRole.WORKER to ModelRef("aif", "m")),
            providers, emptyMap(),
        )
        assertEquals(
            RoutingResult.Unresolved("Provider not configured for worker: aif"),
            r,
        )
    }

    @Test
    fun `no chat selection and no role model is an error`() {
        val r = RoleRouting.resolve(null, emptyMap(), providers, emptyMap())
        assertEquals(RoutingResult.Unresolved("No model selected for planner"), r)
    }

    @Test
    fun `role set without a chat selection still resolves`() {
        val r = RoleRouting.resolve(
            null,
            AgentRole.entries.associateWith { ModelRef("claude", "opus") },
            providers, emptyMap(),
        )
        assertTrue(r is RoutingResult.Resolved)
    }
}

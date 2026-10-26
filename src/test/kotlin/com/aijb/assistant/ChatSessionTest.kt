package com.aijb.assistant

import com.aijb.assistant.chat.ChatListener
import com.aijb.assistant.chat.ChatSession
import com.aijb.assistant.provider.ChatRequest
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.ModelProvider
import com.aijb.assistant.provider.ProviderEvent
import com.aijb.assistant.provider.Role
import com.aijb.assistant.provider.Usage
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

class ChatSessionTest : BasePlatformTestCase() {

    private lateinit var scope: CoroutineScope

    override fun setUp() {
        super.setUp()
        scope = CoroutineScope(SupervisorJob())
    }

    override fun tearDown() {
        try {
            scope.cancel()
        } finally {
            super.tearDown()
        }
    }

    private class RecordingListener : ChatListener {
        val deltas = StringBuilder()
        val completed = CountDownLatch(1)
        val failed = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        var failure: String? = null

        override fun onDelta(text: String) {
            deltas.append(text)
        }

        override fun onCompleted(usage: Usage?) {
            completed.countDown()
        }

        override fun onFailed(message: String) {
            failure = message
            failed.countDown()
        }

        override fun onCancelled() {
            cancelled.countDown()
        }
    }

    private fun fakeProvider(vararg events: ProviderEvent) = object : ModelProvider {
        override val id = "fake"
        override suspend fun listModels(): List<ModelInfo> = emptyList()
        override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
            events.forEach { emit(it) }
        }
    }

    private fun pumpUntil(latch: CountDownLatch, timeoutMs: Long = 10_000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (latch.await(20, TimeUnit.MILLISECONDS)) return true
        }
        return false
    }

    fun `test completed turn appends user and assistant`() {
        val session = ChatSession(project, scope)
        session.provider = fakeProvider(
            ProviderEvent.TextDelta("he"),
            ProviderEvent.TextDelta("llo"),
            ProviderEvent.Completed("stop", Usage(1, 2)),
        )
        val listener = RecordingListener()
        val job = session.send("hi", "m", listener)
        assertTrue(pumpUntil(listener.completed))
        runUntilIdle { job.isCompleted }
        assertEquals("hello", listener.deltas.toString())
        assertEquals(2, session.transcript.size)
        assertEquals(Role.USER, session.transcript[0].role)
        assertEquals("hi", session.transcript[0].content)
        assertEquals(Role.ASSISTANT, session.transcript[1].role)
        assertEquals("hello", session.transcript[1].content)
    }

    fun `test cancel mid stream does not append assistant`() {
        val session = ChatSession(project, scope)
        session.provider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                emit(ProviderEvent.TextDelta("partial"))
                while (true) {
                    delay(20)
                    emit(ProviderEvent.TextDelta("."))
                }
            }
        }
        val listener = RecordingListener()
        val job = session.send("hi", "m", listener)
        Thread.sleep(300)
        pumpUntil(CountDownLatch(1), 100)
        session.cancel()
        assertTrue(pumpUntil(listener.cancelled))
        assertEquals(1, session.transcript.size)
        assertEquals(Role.USER, session.transcript[0].role)
        assertTrue(job.isCancelled || job.isCompleted)
    }

    fun `test failure does not append assistant`() {
        val session = ChatSession(project, scope)
        session.provider = fakeProvider(
            ProviderEvent.TextDelta("partial"),
            ProviderEvent.Failed("boom"),
        )
        val listener = RecordingListener()
        session.send("hi", "m", listener)
        assertTrue(pumpUntil(listener.failed))
        assertEquals("boom", listener.failure)
        assertEquals(1, session.transcript.size)
    }

    fun `test send while active cancels previous job`() {
        val session = ChatSession(project, scope)
        session.provider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                while (true) {
                    delay(20)
                    emit(ProviderEvent.TextDelta("."))
                }
            }
        }
        val first = RecordingListener()
        val firstJob = session.send("one", "m", first)
        Thread.sleep(200)
        val second = RecordingListener()
        val secondJob = session.send("two", "m", second)
        assertTrue(pumpUntil(first.cancelled))
        assertTrue(firstJob.isCancelled || firstJob.isCompleted)
        session.cancel()
        assertTrue(pumpUntil(second.cancelled))
        assertTrue(secondJob.isCancelled || secondJob.isCompleted)
        assertEquals(2, session.transcript.size)
        assertEquals("one", session.transcript[0].content)
        assertEquals("two", session.transcript[1].content)
    }

    fun `test transcript snapshot is immutable`() {
        val session = ChatSession(project, scope)
        session.provider = fakeProvider(
            ProviderEvent.TextDelta("x"),
            ProviderEvent.Completed("stop", null),
        )
        val listener = RecordingListener()
        session.send("hi", "m", listener)
        assertTrue(pumpUntil(listener.completed))
        val snapshot = session.transcript
        val size = snapshot.size
        session.send("second", "m", RecordingListener())
        assertEquals(size, snapshot.size)
    }

    fun `test completed with empty reply appends nothing`() {
        val session = ChatSession(project, scope)
        session.provider = fakeProvider(ProviderEvent.Completed("stop", null))
        val listener = RecordingListener()
        session.send("hi", "m", listener)
        assertTrue(pumpUntil(listener.completed))
        assertEquals(1, session.transcript.size)
    }

    fun `test provider exception leaves transcript with user only`() {
        val session = ChatSession(project, scope)
        session.provider = object : ModelProvider {
            override val id = "fake"
            override suspend fun listModels(): List<ModelInfo> = emptyList()
            override fun chat(request: ChatRequest): Flow<ProviderEvent> = flow {
                throw RuntimeException("stream broke")
            }
        }
        val listener = RecordingListener()
        val job = session.send("hi", "m", listener)
        runUntilIdle { job.isCompleted }
        assertEquals(1, session.transcript.size)
    }

    private fun runUntilIdle(cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            if (cond()) return
            Thread.sleep(20)
        }
        fail("condition not met")
    }
}

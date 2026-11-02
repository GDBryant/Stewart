package com.aijb.assistant

import com.aijb.assistant.chat.PromptHistory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PromptHistoryTest {
    private fun h() = PromptHistory().apply { reset(listOf("a", "b", "c")) }

    @Test fun olderWalksBackwards() {
        val h = h()
        assertEquals("c", h.older())
        assertEquals("b", h.older())
        assertTrue(h.browsing)
    }

    @Test fun olderStopsAtOldest() {
        val h = h()
        repeat(3) { h.older() }
        assertNull(h.older())
        assertTrue(h.browsing)
    }

    @Test fun newerAfterOlder() {
        val h = h()
        h.older()
        h.older()
        assertEquals("c", h.newer())
    }

    @Test fun newerPastNewestClearsAndStops() {
        val h = h()
        h.older()
        assertEquals("", h.newer())
        assertFalse(h.browsing)
    }

    @Test fun newerWhenNotBrowsingIsNull() = assertNull(h().newer())

    @Test fun emptyHistory() {
        val h = PromptHistory()
        assertNull(h.older())
        assertFalse(h.browsing)
    }

    @Test fun stopBrowsingEndsWalk() {
        val h = h()
        h.older()
        h.stopBrowsing()
        assertFalse(h.browsing)
        assertNull(h.newer())
        assertEquals("c", h.older())
    }

    @Test fun resetDiscardsPosition() {
        val h = h()
        h.older()
        h.reset(listOf("x"))
        assertFalse(h.browsing)
        assertEquals("x", h.older())
    }
}

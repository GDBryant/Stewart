package com.adb.stewart

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EnvTest {
    @Test
    fun `remote dev probe true and false`() {
        assertTrue(Env.isRemoteDev { true })
        assertFalse(Env.isRemoteDev { false })
    }

    @Test
    fun `throwing probe reports local`() {
        assertFalse(Env.isRemoteDev { throw RuntimeException("no AppMode") })
    }

    @Test
    fun `default probe does not throw`() {
        Env.isRemoteDev()
    }
}

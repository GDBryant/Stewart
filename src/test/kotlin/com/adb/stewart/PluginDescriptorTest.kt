package com.adb.stewart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test

class PluginDescriptorTest {

    private val xml: String by lazy {
        val found = javaClass.classLoader.getResources("META-INF/plugin.xml").toList()
            .map { it.readText() }
            .firstOrNull { it.contains("<id>com.adb.stewart</id>") }
        assertNotNull("plugin.xml for com.adb.stewart on the test classpath", found)
        found!!
    }

    private fun attr(name: String): List<String> =
        Regex("""$name="([^"]*)"""").findAll(xml).map { it.groupValues[1] }.toList()

    @Test
    fun `descriptor names the plugin Stewart by ADB`() {
        assertEquals("Stewart", Regex("<name>([^<]*)</name>").find(xml)!!.groupValues[1])
        assertEquals("ADB", Regex("<vendor>([^<]*)</vendor>").find(xml)!!.groupValues[1])
    }

    @Test
    fun `tool window and configurables display Stewart`() {
        val toolWindowId = Regex("""<toolWindow id="([^"]*)"""").find(xml)!!.groupValues[1]
        assertEquals("Stewart", toolWindowId)
        assertEquals(listOf("Stewart", "Stewart"), attr("displayName"))
    }

    @Test
    fun `descriptor has no old AIJB display text`() {
        assertFalse(xml.contains("AIJB"))
    }
}

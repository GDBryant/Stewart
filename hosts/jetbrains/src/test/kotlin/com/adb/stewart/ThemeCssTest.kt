package com.adb.stewart

import com.adb.stewart.webview.ThemeColors
import com.adb.stewart.webview.ThemeCss
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.Color

class ThemeCssTest {
    private val dark = ThemeColors(
        dark = true,
        bg = Color(16, 17, 18),
        fg = Color(238, 238, 238),
        inputBg = Color(30, 31, 32),
        inputFg = Color(240, 240, 240),
        border = Color(60, 61, 62),
        accent = Color(53, 116, 240),
        accentFg = Color.WHITE,
    )
    private val light = dark.copy(dark = false)

    @Test
    fun `hex ignores alpha and is lowercase rrggbb`() {
        assertEquals("#010203", ThemeCss.hex(Color(1, 2, 3, 128)))
        assertEquals("#ffffff", ThemeCss.hex(Color.WHITE))
    }

    @Test
    fun `css emits dark scheme and all vars`() {
        val css = ThemeCss.css(dark)
        assertTrue(css.contains("color-scheme:dark"))
        for (v in listOf("--st-bg:#101112", "--st-fg:#eeeeee", "--st-input-bg:#1e1f20", "--st-input-fg:#f0f0f0", "--st-border:#3c3d3e", "--st-accent:#3574f0", "--st-accent-fg:#ffffff")) {
            assertTrue("missing $v", css.contains(v))
        }
    }

    @Test
    fun `css emits light scheme`() {
        val css = ThemeCss.css(light)
        assertTrue(css.contains("color-scheme:light"))
        assertFalse(css.contains("color-scheme:dark"))
    }

    @Test
    fun `applyJs escapes quotes newlines and closing script`() {
        val js = ThemeCss.applyJs("a\"b\n</script>")
        assertTrue(js.contains("stewart-theme"))
        assertTrue(js.contains("\\\"b\\n<\\/script>"))
        assertFalse(js.contains("</script>"))
        assertTrue(js.startsWith("(function(){"))
        assertTrue(js.endsWith("})();"))
    }

    @Test
    fun `current returns usable colors`() {
        val c = ThemeCss.current()
        assertTrue(ThemeCss.css(c).contains("--st-bg:#"))
    }
}

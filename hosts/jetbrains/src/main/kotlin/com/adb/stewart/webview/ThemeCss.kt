package com.adb.stewart.webview

import com.intellij.ui.JBColor
import com.intellij.util.ui.UIUtil
import kotlinx.serialization.json.JsonPrimitive
import java.awt.Color
import javax.swing.UIManager

data class ThemeColors(
    val dark: Boolean,
    val bg: Color,
    val fg: Color,
    val inputBg: Color,
    val inputFg: Color,
    val border: Color,
    val accent: Color,
    val accentFg: Color,
)

object ThemeCss {
    fun hex(c: Color): String = "#%02x%02x%02x".format(c.red, c.green, c.blue)

    fun css(c: ThemeColors): String =
        ":root{color-scheme:${if (c.dark) "dark" else "light"};--st-bg:${hex(c.bg)};--st-fg:${hex(c.fg)};" +
            "--st-input-bg:${hex(c.inputBg)};--st-input-fg:${hex(c.inputFg)};--st-border:${hex(c.border)};" +
            "--st-accent:${hex(c.accent)};--st-accent-fg:${hex(c.accentFg)}}"

    fun applyJs(css: String): String =
        "(function(){var e=document.getElementById('stewart-theme');if(e)e.textContent=${JsonPrimitive(css).toString().replace("</", "<\\/")};})();"

    fun current(): ThemeColors = ThemeColors(
        dark = !JBColor.isBright(),
        bg = UIUtil.getPanelBackground(),
        fg = UIUtil.getLabelForeground(),
        inputBg = UIUtil.getTextFieldBackground(),
        inputFg = UIUtil.getTextFieldForeground(),
        border = JBColor.border(),
        accent = UIManager.getColor("Button.default.startBackground") ?: Color(0x3574F0),
        accentFg = UIManager.getColor("Button.default.foreground") ?: Color.WHITE,
    )
}

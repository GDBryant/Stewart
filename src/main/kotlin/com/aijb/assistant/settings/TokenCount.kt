package com.aijb.assistant.settings

import java.math.BigDecimal

object TokenCount {
    private val plain = Regex("\\d+")
    private val kilo = Regex("(\\d+(?:\\.\\d+)?)[kK]")

    fun parse(s: String): Int? {
        val t = s.trim()
        if (plain.matches(t)) {
            return t.toLongOrNull()?.takeIf { it in 1..Int.MAX_VALUE }?.toInt()
        }
        val m = kilo.matchEntire(t) ?: return null
        val millis = m.groupValues[1].toBigDecimal().multiply(BigDecimal(1000))
        if (millis.stripTrailingZeros().scale() > 0) return null
        val n = millis.toLong()
        return if (n in 1..Int.MAX_VALUE) n.toInt() else null
    }

    fun format(n: Int): String = if (n % 1000 == 0) "${n / 1000}k" else n.toString()
}

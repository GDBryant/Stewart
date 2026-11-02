package com.adb.stewart.chat

import com.adb.stewart.provider.Usage
import java.util.Locale

/** Status-line text for token usage and provider-reported cost. */
object UsageFormat {
    fun tokens(u: Usage): String = "${u.promptTokens ?: "?"} in / ${u.completionTokens ?: "?"} out"

    /** Cost only as reported by the provider; local and unpriced providers show "n/a", never $0. */
    fun cost(u: Usage): String =
        u.costUsd?.let { "$" + String.format(Locale.ROOT, "%.4f", it) } ?: "n/a"

    /** "Done" with no usage; otherwise the request figures, plus session totals once they differ. */
    fun status(request: Usage?, session: Usage?): String {
        if (request == null) return "Done"
        val base = "tokens: ${tokens(request)} · cost ${cost(request)}"
        return if (session != null && session != request) {
            "$base · session: ${tokens(session)} · cost ${cost(session)}"
        } else {
            base
        }
    }
}

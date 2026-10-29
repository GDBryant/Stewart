package com.aijb.assistant.chat

/** Maps provider/loop failure codes to an actionable next step shown next to the error. */
object ErrorHints {
    fun hint(code: String?): String? = when (code) {
        "auth" -> "Sign in with the Claude CLI (run `claude` in a terminal), then retry."
        "cli_not_found" -> "Set the Claude CLI path in Settings → Tools → AIJB Assistant."
        "cli_exit", "cli_error" -> "Run the Claude CLI in a terminal to see its error."
        "model_unavailable" -> "Pick another model or check access to this one."
        "rate_limited" -> "Rate limit reached; wait a moment and retry."
        "isolation_violation" -> "The Claude CLI ran something outside the plugin's tool gates and was stopped. Check its managed settings."
        "missing_api_key" -> "Store the AIF API key in Settings → Tools → AIJB Assistant."
        "native_tools_unsupported" -> "Set this model's tool path to SHIM in Settings."
        "invalid_upstream_response", "incomplete_stream", "protocol_error", "empty_turn" ->
            "The provider returned an unusable response; retry, or try another model."
        "context_limit" -> "The conversation is too large; clear history or lower the auto-compact threshold."
        "truncated" -> "The reply hit the output limit; ask for a shorter answer or split the task."
        "turn_limit" -> "Ask the assistant to continue, or break the task into smaller steps."
        "provider_missing" -> "Configure the provider in Settings → Tools → AIJB Assistant."
        else -> null
    }

    fun format(message: String, code: String?): String =
        hint(code)?.let { "$message — $it" } ?: message
}

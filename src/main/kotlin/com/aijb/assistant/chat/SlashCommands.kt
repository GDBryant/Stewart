package com.aijb.assistant.chat

/** What a slash command can act on; `ChatPanel` implements it, tests use a fake. */
interface CommandContext {
    /** True while a chat run is active. */
    val running: Boolean

    /** Local output: shown in the panel, never added to the transcript or sent to the model. */
    fun show(text: String)

    fun error(text: String)
}

/** A local command; [handler] gets the trimmed args and returns false to keep the input text. */
class SlashCommand(
    val name: String,
    val argHint: String,
    val description: String,
    val allowedWhileRunning: Boolean,
    val handler: (CommandContext, String) -> Boolean,
)

object SlashCommands {

    data class Parsed(val name: String, val args: String)

    /**
     * A command only when the untrimmed [input] starts with a single "/"; "//" escapes to plain
     * text (see [plainText]). The name is lowercased; args are trimmed.
     */
    fun parse(input: String): Parsed? {
        if (!input.startsWith("/") || input.startsWith("//")) return null
        val body = input.substring(1)
        val rawName = body.takeWhile { !it.isWhitespace() }
        return Parsed(rawName.lowercase(), body.substring(rawName.length).trim())
    }

    /** Text to send for non-command input: a leading "//" sends a single "/". */
    fun plainText(input: String): String = if (input.startsWith("//")) input.substring(1) else input

    val all: List<SlashCommand> = listOf(
        SlashCommand("help", "", "List commands", allowedWhileRunning = true) { ctx, _ ->
            ctx.show(help())
            true
        },
    )

    fun find(name: String): SlashCommand? = all.firstOrNull { it.name == name }

    fun help(): String = "Commands:\n" + all.joinToString("\n") { c ->
        val usage = if (c.argHint.isEmpty()) "/${c.name}" else "/${c.name} ${c.argHint}"
        "$usage — ${c.description}"
    }

    /** Runs [parsed]; false (input kept) for an unknown command, one blocked by a run, or a handler error. */
    fun execute(parsed: Parsed, ctx: CommandContext): Boolean {
        val command = find(parsed.name)
        if (command == null) {
            ctx.error("Unknown command /${parsed.name} — type /help")
            return false
        }
        if (ctx.running && !command.allowedWhileRunning) {
            ctx.error("/${command.name} is not available while running")
            return false
        }
        return command.handler(ctx, parsed.args)
    }
}

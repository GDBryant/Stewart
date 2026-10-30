package com.aijb.assistant.chat

import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.provider.Usage

/** What a slash command can act on; `ChatPanel` implements it, tests use a fake. */
interface CommandContext {
    /** True while a chat run is active. */
    val running: Boolean

    /** Local output: shown in the panel, never added to the transcript or sent to the model. */
    fun show(text: String)

    fun error(text: String)

    /** Session totals, as for the status line. */
    val usage: Usage?

    /** Models from the last load, in picker order. */
    val models: List<ModelInfo>
    val currentModel: ModelInfo?

    fun clear()
    fun openSettings()
    fun selectModel(model: ModelInfo)
    fun openModelPicker()
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

    sealed interface ModelMatch {
        data class Found(val model: ModelInfo) : ModelMatch
        data class Ambiguous(val candidates: List<ModelInfo>) : ModelMatch
        data object NotFound : ModelMatch
    }

    /** Exact "provider/model" first, else a bare model id when exactly one provider has it. */
    fun matchModel(arg: String, models: List<ModelInfo>): ModelMatch {
        models.firstOrNull { it.ref.encode() == arg }?.let { return ModelMatch.Found(it) }
        val byId = models.filter { it.ref.modelId == arg }
        return when (byId.size) {
            0 -> ModelMatch.NotFound
            1 -> ModelMatch.Found(byId[0])
            else -> ModelMatch.Ambiguous(byId)
        }
    }

    private fun listRefs(models: List<ModelInfo>): String = models.joinToString(", ") { it.ref.encode() }

    private fun model(ctx: CommandContext, arg: String): Boolean {
        if (arg.isEmpty()) {
            val current = ctx.currentModel
            if (current == null) ctx.error("No model selected") else ctx.show("Model: ${current.ref.encode()}")
            ctx.openModelPicker()
            return true
        }
        return when (val match = matchModel(arg, ctx.models)) {
            is ModelMatch.Found -> {
                ctx.selectModel(match.model)
                ctx.show("Model: ${match.model.ref.encode()}")
                true
            }
            is ModelMatch.Ambiguous -> {
                ctx.error("Model $arg is ambiguous: ${listRefs(match.candidates)}")
                false
            }
            ModelMatch.NotFound -> {
                val available = if (ctx.models.isEmpty()) "none loaded" else listRefs(ctx.models)
                ctx.error("Unknown model $arg. Available: $available")
                false
            }
        }
    }

    private fun cost(ctx: CommandContext) {
        val usage = ctx.usage
        ctx.show(
            if (usage == null) "No usage yet"
            else "Session: tokens ${UsageFormat.tokens(usage)} · cost ${UsageFormat.cost(usage)}"
        )
    }

    val all: List<SlashCommand> = listOf(
        SlashCommand("help", "", "List commands", allowedWhileRunning = true) { ctx, _ ->
            ctx.show(help())
            true
        },
        SlashCommand("clear", "", "Clear the conversation and its saved history", allowedWhileRunning = false) { ctx, _ ->
            ctx.clear()
            true
        },
        SlashCommand("cost", "", "Show token use and cost for this chat", allowedWhileRunning = true) { ctx, _ ->
            cost(ctx)
            true
        },
        SlashCommand("model", "[provider/model]", "Show or switch the model", allowedWhileRunning = false, ::model),
        SlashCommand("config", "", "Open the plugin settings", allowedWhileRunning = false) { ctx, _ ->
            ctx.openSettings()
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

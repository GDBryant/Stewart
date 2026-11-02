package com.aijb.assistant.chat

import com.aijb.assistant.agents.AgentRole
import com.aijb.assistant.provider.ModelInfo
import com.aijb.assistant.tools.permissions.ApprovalCategory
import com.aijb.assistant.provider.ModelRef
import com.aijb.assistant.provider.Usage

/** What a slash command can act on; `ChatPanel` implements it, tests use a fake. */
/** Project and chat permission state for `/permissions`; `ChatPanel` implements it. */
interface PermissionsView {
    val ticks: Set<ApprovalCategory>
    val alwaysPrograms: Set<String>
    val projectPath: String?
    val chatCategories: Set<ApprovalCategory>
    val chatPrograms: Set<String>

    fun clearChat()

    /** Removes the project tick and the chat category grant. */
    fun revokeCategory(category: ApprovalCategory)

    /** Removes the always grant and the chat grant for one program (verbatim). */
    fun revokeProgram(program: String)

    /** Removes this project's whole entry (ticks + programs). */
    fun resetProject()
}

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

    /** True when the three-level orchestrator is in use; the main picker is then disabled. */
    val multiModel: Boolean

    /** Per-role bindings as `provider/model`, or null when a role is unset. */
    fun roleModels(): Map<AgentRole, ModelRef?>

    fun selectRoleModel(role: AgentRole, model: ModelInfo)

    fun clear()
    fun openSettings()
    fun selectModel(model: ModelInfo)
    fun openModelPicker()

    /** Starts a forced compaction run; false (with an error shown) when it cannot start. */
    fun compact(focus: String?): Boolean

    /** Sends [prompt] to the model as a normal message; false (with an error shown) when it cannot. */
    fun sendPrompt(prompt: String): Boolean

    /**
     * `/init`: ensure AGENTS.md and docs/ai_docs exist, then ask once whether to run the
     * investigation; the model prompt is sent only when the user chooses to continue.
     */
    fun init(): Boolean

    /** Reads the diff off the EDT, then calls [SlashCommands.reviewRequest] and sends or shows the result. */
    fun review(focus: String?): Boolean

    /** Approval permissions for `/permissions`. */
    val permissions: PermissionsView
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

    private fun roleBindings(ctx: CommandContext): String =
        ctx.roleModels().entries.joinToString("\n") { (role, ref) ->
            "${role.name.lowercase()}: ${ref?.encode() ?: "unset"}"
        }

    private fun model(ctx: CommandContext, arg: String): Boolean {
        val words = arg.split(Regex("\\s+")).filter { it.isNotEmpty() }
        val role = words.firstOrNull()?.let { w -> AgentRole.entries.firstOrNull { it.name.equals(w, true) } }
        if (arg.isEmpty()) {
            if (ctx.multiModel) {
                ctx.show("Multi-model roles:\n" + roleBindings(ctx) + "\nUse /model <planner|executor|worker> <provider/model>")
                return true
            }
            val current = ctx.currentModel
            if (current == null) ctx.error("No model selected") else ctx.show("Model: ${current.ref.encode()}")
            ctx.openModelPicker()
            return true
        }
        if (role != null && !ctx.multiModel) {
            ctx.error("Role models apply in multi-model mode only; enable it in Roles")
            return false
        }
        if (role == null && ctx.multiModel) {
            ctx.error("Multi-model mode: use /model <planner|executor|worker> <provider/model>")
            return false
        }
        if (role != null && words.size != 2) {
            ctx.error("Usage: /model ${role.name.lowercase()} <provider/model>")
            return false
        }
        val target = if (role != null) words[1] else arg
        return when (val match = matchModel(target, ctx.models)) {
            is ModelMatch.Found -> {
                if (role != null) {
                    ctx.selectRoleModel(role, match.model)
                    ctx.show("${role.name.lowercase()}: ${match.model.ref.encode()}")
                } else {
                    ctx.selectModel(match.model)
                    ctx.show("Model: ${match.model.ref.encode()}")
                }
                true
            }
            is ModelMatch.Ambiguous -> {
                ctx.error("Model $target is ambiguous: ${listRefs(match.candidates)}")
                false
            }
            ModelMatch.NotFound -> {
                val available = if (ctx.models.isEmpty()) "none loaded" else listRefs(ctx.models)
                ctx.error("Unknown model $target. Available: $available")
                false
            }
        }
    }

    /** Diff budget for `/review`; larger than the orchestrator's 2000-char handoff so a review is useful. */
    const val REVIEW_MAX_DIFF_CHARS = 20_000

    /** Shown once after /init created or confirmed the files; option 0 sends [INIT_PROMPT]. */
    const val INIT_QUESTION = "AGENTS.md and docs/ai_docs are in place. Investigate the project and fill them in now?"
    const val INIT_INVESTIGATE = "Investigate and summarise the project"
    const val INIT_STOP = "Stop here for now"

    const val INIT_PROMPT = "Inspect this project (layout, build files, README, main source and test directories) " +
        "with the read-only tools, then update AGENTS.md at the project root and the memory files under " +
        "docs/ai_docs/ with EditFile or WriteFile. Keep them brief: a one-line description, the build/test/run " +
        "commands, the code layout, and the conventions you can confirm from the code. If a file is still " +
        "accurate, leave it alone. Do not guess commands you could not confirm."

    sealed interface ReviewRequest {
        data class Send(val prompt: String) : ReviewRequest
        data class Message(val text: String, val isError: Boolean) : ReviewRequest
    }

    /** What `/review` does for a diff result: a prompt with the (bounded) diff inlined, or a local message. */
    fun reviewRequest(diff: GitDiff.Result, focus: String?, maxChars: Int = REVIEW_MAX_DIFF_CHARS): ReviewRequest =
        when (diff) {
            GitDiff.Result.NoChanges -> ReviewRequest.Message("No changes to review", isError = false)
            GitDiff.Result.NoCommits -> ReviewRequest.Message("No commits yet: nothing to diff against", isError = true)
            is GitDiff.Result.NotRepo -> ReviewRequest.Message("Cannot review: ${diff.message}", isError = true)
            is GitDiff.Result.Diff -> ReviewRequest.Send(reviewPrompt(diff.text, focus, maxChars))
        }

    private fun reviewPrompt(text: String, focus: String?, maxChars: Int): String {
        val truncated = text.length > maxChars
        val bounded = if (truncated) text.take(maxChars) else text
        val note = if (truncated) {
            "\n[diff truncated: ${text.length - maxChars} of ${text.length} chars omitted; read the files for the rest]"
        } else {
            ""
        }
        val focusLine = if (focus.isNullOrBlank()) "" else "Focus on: ${focus.trim()}\n"
        return "Review the uncommitted changes below (git diff HEAD). Report bugs, risky changes, missing tests " +
            "and unclear code, most severe first, each with file and line. Do not modify any files.\n" +
            focusLine + "\n```diff\n" + bounded + (if (bounded.endsWith("\n")) "" else "\n") + "```" + note
    }

    private const val PERMISSIONS_USAGE =
        "Usage: /permissions [clear|reset|revoke <edits|commands|other|all|program>]"

    private fun describePermissions(v: PermissionsView): String {
        fun names(set: Set<ApprovalCategory>) =
            set.joinToString(", ") { it.name.lowercase() }.ifEmpty { "(none)" }
        fun progs(set: Set<String>) = set.sorted().joinToString(", ").ifEmpty { "(none)" }
        return "Permissions for ${v.projectPath ?: "this project"}:\n" +
            "ticks: ${names(v.ticks)}\n" +
            "always programs: ${progs(v.alwaysPrograms)}\n" +
            "chat categories: ${names(v.chatCategories)}\n" +
            "chat programs: ${progs(v.chatPrograms)}"
    }

    private fun permissions(ctx: CommandContext, args: String): Boolean {
        val view = ctx.permissions
        val note = if (ctx.running) " (applies to the next tool call in this run)" else ""
        return when {
            args.isEmpty() -> {
                ctx.show(describePermissions(view))
                true
            }
            args == "clear" -> {
                view.clearChat()
                ctx.show("Chat grants cleared$note")
                true
            }
            args == "reset" -> {
                view.resetProject()
                ctx.show("Project permissions removed$note")
                true
            }
            args == "revoke" || args.startsWith("revoke ") -> {
                val target = args.removePrefix("revoke").trim()
                when {
                    target.isEmpty() -> {
                        ctx.error(PERMISSIONS_USAGE)
                        false
                    }
                    target == "all" -> {
                        view.resetProject()
                        ctx.show("Project permissions removed$note")
                        true
                    }
                    else -> {
                        val category = ApprovalCategory.entries.firstOrNull { it.name.equals(target, true) }
                        if (category != null) {
                            val had = view.ticks.contains(category) || view.chatCategories.contains(category)
                            view.revokeCategory(category)
                            ctx.show(
                                (if (had) "Revoked ${category.name.lowercase()}"
                                else "No ${category.name.lowercase()} grant") + note,
                            )
                        } else {
                            val had = view.alwaysPrograms.contains(target) || view.chatPrograms.contains(target)
                            view.revokeProgram(target)
                            ctx.show((if (had) "Revoked $target" else "No grant for $target") + note)
                        }
                        true
                    }
                }
            }
            else -> {
                ctx.error(PERMISSIONS_USAGE)
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
        SlashCommand("compact", "[focus]", "Compact the conversation now, optionally keeping a focus", allowedWhileRunning = false) { ctx, args ->
            ctx.compact(args.ifEmpty { null })
        },
        SlashCommand("init", "", "Prepare AGENTS.md and docs/ai_docs, then optionally investigate", allowedWhileRunning = false) { ctx, _ ->
            ctx.init()
        },
        SlashCommand("review", "[focus]", "Review the uncommitted changes (git diff HEAD)", allowedWhileRunning = false) { ctx, args ->
            ctx.review(args.ifEmpty { null })
        },
        SlashCommand("model", "[role] [provider/model]", "Show or switch the model (or a role's model in multi-model mode)", allowedWhileRunning = false, ::model),
        SlashCommand("config", "", "Open the plugin settings", allowedWhileRunning = false) { ctx, _ ->
            ctx.openSettings()
            true
        },
        SlashCommand("permissions", "[clear|reset|revoke <target>]", "List or change approval permissions", allowedWhileRunning = true, ::permissions),
    )

    fun find(name: String): SlashCommand? = all.firstOrNull { it.name == name }

    /** Autocomplete: commands whose name starts with the typed prefix, until a space is typed. */
    fun complete(input: String): List<SlashCommand> {
        if (!input.startsWith("/") || input.startsWith("//") || input.any { it.isWhitespace() }) return emptyList()
        val prefix = input.substring(1).lowercase()
        return all.filter { it.name.startsWith(prefix) }
    }

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

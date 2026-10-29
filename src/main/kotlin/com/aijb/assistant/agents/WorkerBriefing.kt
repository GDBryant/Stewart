package com.aijb.assistant.agents

/**
 * The only context a Worker receives: its own task plus the results of the tasks it
 * explicitly depends on. One fact per line, bounded to [maxChars]; oldest prior
 * results are dropped first, then the goal is shortened, so the Task line survives.
 */
internal fun workerBriefing(
    goal: String,
    milestone: Milestone,
    task: DispatchTask,
    prior: List<WorkerResult>,
    maxChars: Int,
): String {
    fun oneLine(s: String) = s.trim().replace(Regex("\\s+"), " ")
    val tail = buildList {
        add("Milestone ${milestone.id}: ${milestone.title}")
        add("Task ${task.id}: ${oneLine(task.description)}")
        if (task.files.isNotEmpty()) add("Files: ${task.files.joinToString(", ")}")
    }
    val priorLines = prior.map { "Prior #${it.taskId} ${it.status}: ${oneLine(it.summary)}" }.toMutableList()
    fun render(goalText: String) = (listOf("Goal: $goalText") + tail + priorLines).joinToString("\n")

    var text = render(oneLine(goal))
    while (text.length > maxChars && priorLines.isNotEmpty()) {
        priorLines.removeAt(0)
        text = render(oneLine(goal))
    }
    if (text.length > maxChars) {
        val over = text.length - maxChars
        val g = oneLine(goal)
        val keep = (g.length - over - 1).coerceAtLeast(0)
        text = render(g.take(keep) + "…")
    }
    return if (text.length <= maxChars) text else text.take(maxChars) + "…"
}

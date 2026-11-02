package com.aijb.assistant.tools.permissions

import com.aijb.assistant.tools.ToolPreview

enum class ApprovalCategory {
    EDITS,
    COMMANDS,
    OTHER,
}

/** Null or unrecognised previews have no category and can never be bypassed. */
fun categoryOf(preview: ToolPreview?): ApprovalCategory? = when (preview) {
    is ToolPreview.FileChange -> ApprovalCategory.EDITS
    is ToolPreview.Command -> ApprovalCategory.COMMANDS
    is ToolPreview.Other -> ApprovalCategory.OTHER
    else -> null
}

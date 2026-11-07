/** What the approval UI shows before a gated tool runs. */
export type ToolPreview =
  | { kind: "file"; path: string; before: string | null; after: string }
  | { kind: "command"; command: string; cwd: string }
  | { kind: "other"; category?: ApprovalCategory };

export type ApprovalCategory = "EDITS" | "COMMANDS" | "OTHER" | (string & {});

export function categoryOf(preview: ToolPreview | null | undefined, tool?: { category?: ApprovalCategory }): ApprovalCategory | null {
  if (tool?.category) return tool.category;
  if (!preview) return null;
  if (preview.kind === "file") return "EDITS";
  if (preview.kind === "command") return "COMMANDS";
  if (preview.kind === "other") return preview.category ?? "OTHER";
  return null;
}

export type TaskSize = "quick" | "normal" | "deep";

export interface TaskSizeCtx {
  workspaceSize?: "small" | "medium" | "large";
  fileMentions?: number;
  hasAttachments?: boolean;
  orchestrated?: boolean;
}

const QUICK_WORDS = /(?:^|\W)(script|one-?liner|snippet|regex|explain|rename|typo)\b/i;
const DEEP_WORDS = /(?:^|\W)(refactor|migrate|across|all tests|architecture|entire|rewrite|every\b)/i;
const FILE_MENTION = /@[\w./-]+\.\w{1,6}\b/g;

const QUICK_THRESHOLD = 2;
const DEEP_THRESHOLD = -2;

/** Pure, deterministic task-size guess; user overrides and callers supply the context. */
export function classifyTask(prompt: string, ctx: TaskSizeCtx = {}): TaskSize {
  let score = 0;
  if (prompt.trim().length < 160) score += 1;
  else if (prompt.length > 1200) score -= 2;
  if (QUICK_WORDS.test(prompt)) score += 2;
  if (DEEP_WORDS.test(prompt)) score -= 2;
  const mentions = ctx.fileMentions ?? (prompt.match(FILE_MENTION)?.length ?? 0);
  if (mentions >= 3) score -= 1;
  if (ctx.workspaceSize === "large") score -= 1;
  if (ctx.hasAttachments) score -= 1;
  if (ctx.orchestrated) score -= 1;
  if (score >= QUICK_THRESHOLD) return "quick";
  if (score <= DEEP_THRESHOLD) return "deep";
  return "normal";
}

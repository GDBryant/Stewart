import type { HostPort } from "@stewart/kernel";

const MENTION = /@(file:[^\s@]+|selection|problems)\b/g;
const FILE_CAP = 8_000;
const PROBLEMS_CAP = 50;

export interface MentionResult {
  text: string;
  expanded: string[];
  dropped: string[];
}

/**
 * Expand `@file:<path>`, `@selection` and `@problems` in chat input. Mentions
 * stay in the text; resolved content is appended as context blocks so the user
 * sees what they typed and the model sees what it referenced.
 */
type MentionHost = Pick<HostPort, "diag" | "editor" | "files">;
type MentionOutcome = { block?: string; expanded?: string; dropped?: string };

async function fileMention(host: MentionHost, token: string): Promise<MentionOutcome> {
  const path = token.slice(5);
  try {
    const { content } = await host.files.read(path);
    return {
      block: `<file path="${path}">\n${content.slice(0, FILE_CAP)}${content.length > FILE_CAP ? "\n[truncated]" : ""}\n</file>`,
      expanded: `@${token}`,
    };
  } catch {
    return { dropped: `@${token}` };
  }
}

async function selectionMention(host: MentionHost): Promise<MentionOutcome> {
  const sel = await host.editor.selection().catch(() => null);
  if (!sel?.text) return { dropped: "@selection" };
  return {
    block: `<selection path="${sel.path}" lines="${sel.startLine}-${sel.endLine}">\n${sel.text.slice(0, FILE_CAP)}\n</selection>`,
    expanded: "@selection",
  };
}

async function problemsMention(host: MentionHost): Promise<MentionOutcome> {
  const problems = await host.diag.problems().catch(() => []);
  if (!problems.length) return { dropped: "@problems" };
  const lines = problems.slice(0, PROBLEMS_CAP).map((p) => `${p.path}:${p.line} [${p.severity}] ${p.message}`);
  return {
    block: `<problems>\n${lines.join("\n")}${problems.length > PROBLEMS_CAP ? `\n[+${problems.length - PROBLEMS_CAP} more]` : ""}\n</problems>`,
    expanded: "@problems",
  };
}

const MENTION_HANDLERS: { match: (token: string) => boolean; run: (host: MentionHost, token: string) => Promise<MentionOutcome> }[] = [
  { match: (t) => t.startsWith("file:"), run: fileMention },
  { match: (t) => t === "selection", run: selectionMention },
  { match: () => true, run: problemsMention },
];

export async function expandMentions(host: MentionHost, text: string): Promise<MentionResult> {
  const matches = [...text.matchAll(MENTION)];
  if (!matches.length) return { text, expanded: [], dropped: [] };
  const expanded: string[] = [];
  const dropped: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const token = m[1];
    if (seen.has(token)) continue;
    seen.add(token);
    const handler = MENTION_HANDLERS.find((h) => h.match(token))!;
    const r = await handler.run(host, token);
    if (r.block) blocks.push(r.block);
    if (r.expanded) expanded.push(r.expanded);
    if (r.dropped) dropped.push(r.dropped);
  }
  return { text: blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text, expanded, dropped };
}

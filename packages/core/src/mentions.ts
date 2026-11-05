import type { HostPort } from "./ports.js";

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
export async function expandMentions(host: HostPort, text: string): Promise<MentionResult> {
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
    if (token.startsWith("file:")) {
      const path = token.slice(5);
      try {
        const { content } = await host.files.read(path);
        blocks.push(`<file path="${path}">\n${content.slice(0, FILE_CAP)}${content.length > FILE_CAP ? "\n[truncated]" : ""}\n</file>`);
        expanded.push(`@${token}`);
      } catch {
        dropped.push(`@${token}`);
      }
    } else if (token === "selection") {
      const sel = await host.editor.selection().catch(() => null);
      if (sel?.text) {
        blocks.push(`<selection path="${sel.path}" lines="${sel.startLine}-${sel.endLine}">\n${sel.text.slice(0, FILE_CAP)}\n</selection>`);
        expanded.push("@selection");
      } else {
        dropped.push("@selection");
      }
    } else {
      const problems = await host.diag.problems().catch(() => []);
      if (problems.length) {
        const lines = problems.slice(0, PROBLEMS_CAP).map((p) => `${p.path}:${p.line} [${p.severity}] ${p.message}`);
        blocks.push(`<problems>\n${lines.join("\n")}${problems.length > PROBLEMS_CAP ? `\n[+${problems.length - PROBLEMS_CAP} more]` : ""}\n</problems>`);
        expanded.push("@problems");
      } else {
        dropped.push("@problems");
      }
    }
  }
  return { text: blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text, expanded, dropped };
}

/** Hard ceiling on one tool result, in chars. */
export const MAX_OUTPUT_CHARS = 20_000;
/** Window assumed when the agent's is unknown (same default as compaction). */
const DEFAULT_WINDOW = 32_768;
/** One tool result may take this share of the window: 4 chars/token × 8%. */
const WINDOW_SHARE = 4 * 0.08;

/** Per-result char cap for a window in tokens: `min(20_000, window × 4 × 0.08)` — about 10k at 32k. */
export function outputCap(window?: number): number {
  return Math.min(MAX_OUTPUT_CHARS, Math.floor((window ?? DEFAULT_WINDOW) * WINDOW_SHARE));
}

/** Last `N: ` line number in a ReadFile result, or undefined. */
function lastLineNo(text: string): number | undefined {
  const m = /(?:^|\n)(\d+): [^\n]*$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** ReadFile over the cap returns a head window ending on a whole line, with a note naming the line to continue from. */
function capRead(raw: string, cap: number): string {
  const cut = raw.slice(0, cap);
  const head = cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0)) || cut;
  const shown = lastLineNo(head);
  const total = lastLineNo(raw);
  const where = shown !== undefined && total !== undefined ? ` at line ${shown} of ${total}` : "";
  const next = shown !== undefined ? ` (next: start_line=${shown + 1})` : "";
  return `${head}\n[truncated${where}: ${raw.length - head.length} chars omitted; use start_line/end_line to read ranges${next}]`;
}

/** Caps one tool result: ReadFile keeps a head window; everything else keeps 70% head + 30% tail around an omission note. */
export function capOutput(raw: string, cap: number, tool?: string): string {
  if (raw.length <= cap) return raw;
  if (tool === "ReadFile" || tool === "Read") return capRead(raw, cap);
  const head = Math.ceil(cap * 0.7);
  const tail = Math.floor(cap * 0.3);
  return `${raw.slice(0, head)}\n[output truncated: ${raw.length - cap} chars omitted]\n${raw.slice(-tail)}`;
}

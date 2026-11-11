import type { ChatMessage } from "@stewart/kernel";

export function measureMessages(msgs: ChatMessage[]): number {
  return msgs.reduce(
    (n, m) =>
      n +
      ("content" in m ? m.content.length : 0) +
      ("toolCalls" in m && m.toolCalls ? m.toolCalls.reduce((k, c) => k + JSON.stringify(c.arguments).length, 0) : 0),
    0,
  );
}

/**
 * Emergency compaction of `produced` (mutated in place) when `base + produced` exceeds `maxChars`:
 * keeps the last 2 messages, replaces the rest with a clipped snippet note.
 * Returns true when still over the limit afterwards.
 */
export function compactIfOver(
  base: ChatMessage[],
  produced: ChatMessage[],
  maxChars: number,
  hooks: { onCompacted?(beforeTokens: number, afterTokens: number): void; onCompactionFailed?(message: string): void },
): boolean {
  let size = measureMessages([...base, ...produced]);
  if (size > maxChars && produced.length > 2) {
    const beforeTokens = Math.ceil(size / 4);
    const kept = produced.slice(-2);
    const summary = produced
      .slice(0, -2)
      .filter((m) => m.role === "tool" || m.role === "assistant")
      .map((m) => `${m.role}: ${m.content.slice(0, 120)}`)
      .join(" | ")
      .slice(0, Math.max(64, Math.floor(maxChars / 4)));
    produced.splice(0, produced.length, { role: "user", content: `[compacted: ${summary}]` }, ...kept);
    size = measureMessages([...base, ...produced]);
    if (size <= maxChars) hooks.onCompacted?.(beforeTokens, Math.ceil(size / 4));
  }
  if (size > maxChars) {
    hooks.onCompactionFailed?.("context size limit exceeded");
    return true;
  }
  return false;
}

const PRUNE_MIN_CHARS = 500;
const PRUNE_TAIL = 4;

/**
 * Prune stage (no LLM): stubs bulky tool results that are stale — superseded by a later call of the
 * same tool+path, or outside the last `PRUNE_TAIL` messages. Message pairs stay intact; only the
 * result content changes. Mutates `produced`; returns the number of results stubbed.
 */
function collectToolCalls(produced: ChatMessage[]): { calls: Map<string, { name: string; key: string }>; latest: Map<string, string> } {
  const calls = new Map<string, { name: string; key: string }>();
  const latest = new Map<string, string>();
  for (const m of produced) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) {
        const key = `${c.name}:${typeof c.arguments.path === "string" ? c.arguments.path : JSON.stringify(c.arguments)}`;
        calls.set(c.id, { name: c.name, key });
        latest.set(key, c.id);
      }
    }
  }
  return { calls, latest };
}

/** Prune scan state: call index from collectToolCalls plus the first message index still kept verbatim. */
interface PruneScan {
  calls: Map<string, { name: string; key: string }>;
  latest: Map<string, string>;
  cutoff: number;
}

function pruneTarget(m: ChatMessage, i: number, scan: PruneScan): { key: string; len: number } | null {
  if (m.role !== "tool" || m.content.length < PRUNE_MIN_CHARS || m.content.startsWith("[elided")) return null;
  const c = scan.calls.get(m.toolCallId);
  if (!c) return null;
  const superseded = scan.latest.get(c.key) !== m.toolCallId;
  if (!superseded && i >= scan.cutoff) return null;
  return { key: c.key, len: m.content.length };
}

export function pruneStale(produced: ChatMessage[]): number {
  const scan: PruneScan = { ...collectToolCalls(produced), cutoff: produced.length - PRUNE_TAIL };
  let n = 0;
  produced.forEach((m, i) => {
    const t = pruneTarget(m, i, scan);
    if (!t) return;
    produced[i] = { ...m, content: `[elided: ${t.key} ${t.len} chars; re-run the tool if needed]` };
    n++;
  });
  return n;
}

const SUMMARY_TAIL = 6;
const NOTE_PREFIXES = ["[compacted", "[summary"];

export interface SummarySplit {
  /** Messages kept verbatim ahead of the note (the last user message). */
  pinned: ChatMessage[];
  /** Messages to be replaced by a structured note. */
  middle: ChatMessage[];
  /** Last messages kept verbatim; never starts on a tool result. */
  tail: ChatMessage[];
}

/**
 * Pure pinned | middle | tail split of `produced` for the summarize stage. The tail keeps the last
 * `keep` messages, extended backwards so a tool result never loses its assistant tool call.
 * Returns null when there is nothing worth summarizing.
 */
export function splitForSummary(produced: ChatMessage[], keep = SUMMARY_TAIL): SummarySplit | null {
  let start = produced.length - keep;
  while (start > 0 && produced[start]?.role === "tool") start--;
  if (start <= 1) return null;
  const head = produced.slice(0, start);
  const isNote = (m: ChatMessage) => typeof m.content === "string" && NOTE_PREFIXES.some((x) => m.content.startsWith(x));
  let pinIdx = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (head[i]!.role === "user" && !isNote(head[i]!)) {
      pinIdx = i;
      break;
    }
  }
  const pinned = pinIdx >= 0 ? [head[pinIdx]!] : [];
  const middle = head.filter((_, i) => i !== pinIdx);
  if (middle.length === 0) return null;
  return { pinned, middle, tail: produced.slice(start) };
}

/** Render the middle as plain text for the compactor prompt (tool results clipped). */
export function renderForSummary(middle: ChatMessage[]): string {
  return middle
    .map((m) => {
      const calls = m.role === "assistant" && m.toolCalls ? ` calls=${m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 200)})`).join(", ")}` : "";
      return `${m.role}${calls}: ${m.content.slice(0, 1500)}`;
    })
    .join("\n");
}

export const SUMMARY_INSTRUCTIONS =
  "Summarize this agent transcript as a compact note with these headings: Goal, Done, Decisions, Files touched, Open errors, Next step. Keep exact file paths and error text. No preamble.";

/**
 * Summarize stage: replaces the middle of `produced` with one structured note from `summarize`.
 * Returns true when applied; false when no split exists or the summarizer failed/returned nothing
 * (caller falls back to the emergency clip).
 */
export async function summarizeMiddle(
  produced: ChatMessage[],
  summarize: (middle: ChatMessage[]) => Promise<string>,
): Promise<boolean> {
  const split = splitForSummary(produced);
  if (!split) return false;
  let note: string;
  try {
    note = (await summarize(split.middle)).trim();
  } catch {
    return false;
  }
  if (!note) return false;
  produced.splice(0, produced.length, ...split.pinned, { role: "user", content: `[summary of earlier steps]\n${note}` }, ...split.tail);
  return true;
}

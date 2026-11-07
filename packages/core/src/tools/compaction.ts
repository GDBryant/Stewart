import type { ChatMessage } from "../channels/types.js";

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
export function pruneStale(produced: ChatMessage[]): number {
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
  let n = 0;
  const cutoff = produced.length - PRUNE_TAIL;
  produced.forEach((m, i) => {
    if (m.role !== "tool" || m.content.length < PRUNE_MIN_CHARS || m.content.startsWith("[elided")) return;
    const c = calls.get(m.toolCallId);
    if (!c) return;
    const superseded = latest.get(c.key) !== m.toolCallId;
    if (!superseded && i >= cutoff) return;
    produced[i] = { ...m, content: `[elided: ${c.key} ${m.content.length} chars; re-run the tool if needed]` };
    n++;
  });
  return n;
}

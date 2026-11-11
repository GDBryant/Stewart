import { bounded, step } from "./smoke.js";
import { key, RANK_TIMEOUT_MS, type RankCandidate, type SmokeCandidate, type SmokeChannel } from "./probeTypes.js";

/** Deterministic fallback order: configured agents first, then smaller models, then name. */
export function fallbackOrder<T extends SmokeCandidate & { hasAgent?: boolean; sizeB?: number }>(cands: T[]): T[] {
  return [...cands].sort((a, b) => {
    if (!!a.hasAgent !== !!b.hasAgent) return a.hasAgent ? -1 : 1;
    const sa = a.sizeB ?? Number.POSITIVE_INFINITY;
    const sb = b.sizeB ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return key(a).localeCompare(key(b));
  });
}

/**
 * Provider-first split: Ollama candidates probe first, Claude CLI second, the rest
 * go to the evaluator ranking tail. Within local groups the deterministic
 * `fallbackOrder` applies.
 */
export function orderSmokeCandidates<T extends SmokeCandidate & { channelType: string; hasAgent?: boolean; sizeB?: number }>(
  cands: T[],
): { priority: SmokeCandidate[]; rest: T[] } {
  const local = cands.filter((c) => c.channelType === "ollama" || c.channelType === "claude-cli");
  const rest = cands.filter((c) => c.channelType !== "ollama" && c.channelType !== "claude-cli");
  const rank = (c: T) => (c.channelType === "ollama" ? 0 : 1);
  const priority = fallbackOrder(local).sort((a, b) => rank(a) - rank(b));
  return { priority: priority.map(({ channel, model }) => ({ channel, model })), rest: fallbackOrder(rest) };
}

/**
 * Ask the evaluator to order the non-local candidates by expected usefulness.
 * Returns the validated ordering (unknown/duplicate entries dropped, omitted
 * candidates appended in fallback order) or undefined on any failure.
 */
export async function rankCandidates(
  cands: RankCandidate[],
  channel: SmokeChannel,
  model: string,
  opts: { timeoutMs?: number } = {},
): Promise<SmokeCandidate[] | undefined> {
  if (!cands.length) return [];
  const timeoutMs = opts.timeoutMs ?? RANK_TIMEOUT_MS;
  const b = bounded(new AbortController().signal, timeoutMs);
  const it = channel
    .chat({ model, messages: [{ role: "user", content: rankPrompt(cands) }], maxTokens: 512, signal: b.signal })[Symbol.asyncIterator]();
  let text = "";
  try {
    for (;;) {
      const s = await step(() => it.next(), b.stop);
      if (s.kind === "stop" || s.kind === "error" || s.kind === "done") break;
      if (s.value.kind === "text") text += s.value.text;
    }
    if (!text.trim()) return undefined;
    return validateRanking(text, cands);
  } catch {
    return undefined;
  } finally {
    b.cleanup();
    void it.return?.()?.catch(() => {});
  }
}

function rankPrompt(cands: RankCandidate[]): string {
  const lines = cands.map((c) => `- ${key(c)} (${c.channelType}${c.detail ? `, ${c.detail}` : ""})`).join("\n");
  return [
    "Rank these model candidates for a coding assistant, most useful first.",
    "Weigh capability hints, cost and expected reliability; local models are already probed separately so rank only for general assistant work.",
    "",
    lines,
    "",
    'Reply ONLY a JSON object {"order":["channel:model", ...]} using the exact ids above. Include every id exactly once.',
  ].join("\n");
}

/** The `order` array from the first `{` to the last `}` of the reply, or undefined when absent or not JSON. */
function parseOrder(text: string): unknown[] | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: { order?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { order?: unknown };
  } catch {
    return undefined;
  }
  return Array.isArray(parsed.order) ? parsed.order : undefined;
}

function validateRanking(text: string, cands: RankCandidate[]): SmokeCandidate[] | undefined {
  const order = parseOrder(text);
  if (!order) return undefined;
  const known = new Map(cands.map((c) => [key(c), c]));
  const out: SmokeCandidate[] = [];
  const used = new Set<string>();
  for (const e of order) {
    if (typeof e !== "string") continue;
    const c = known.get(e);
    if (!c || used.has(e)) continue;
    used.add(e);
    out.push({ channel: c.channel, model: c.model });
  }
  for (const c of fallbackOrder(cands)) {
    const k = key(c);
    if (!used.has(k)) {
      used.add(k);
      out.push({ channel: c.channel, model: c.model });
    }
  }
  return out;
}

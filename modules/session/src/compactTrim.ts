import type { ChatMessage } from "@stewart/kernel";

/** Chars an old tool result keeps (head + tail) after a trim pass. */
export const STUB_CAP = 1500;
/** Messages at the end of the transcript a first trim pass leaves whole. */
export const KEEP_RECENT = 4;
const MARK = "[Stewart: tool result truncated";

/** Head 2/3 + tail 1/3 of `text` around an explicit marker; text already within `cap` is returned as is. */
export function stubOf(text: string, cap = STUB_CAP): string {
  if (text.length <= cap) return text;
  const head = Math.ceil(cap * (2 / 3));
  const tail = cap - head;
  return `${text.slice(0, head)}\n${MARK}, ${text.length - cap} chars omitted; the full result is archived — re-read only if needed]\n${text.slice(-tail)}`;
}

export interface TrimResult {
  /** Originals of the messages that were shortened, for the archive. */
  originals: ChatMessage[];
  /** Estimated tokens freed (4 chars per token). */
  freedTokens: number;
}

/**
 * Shortens tool results older than the last `keepRecent` messages to head+tail stubs, in place. Results already
 * stubbed or within `cap` are left alone, so repeated passes are cheap and idempotent. Image carriers are untouched.
 */
export function trimOldResults(transcript: ChatMessage[], keepRecent = KEEP_RECENT, cap = STUB_CAP): TrimResult {
  const originals: ChatMessage[] = [];
  let freed = 0;
  for (let i = 0; i < transcript.length - keepRecent; i++) {
    const m = transcript[i];
    if (m.role !== "tool" || m.content.length <= cap || m.content.includes(MARK)) continue;
    originals.push({ ...m });
    const stub = stubOf(m.content, cap);
    freed += m.content.length - stub.length;
    m.content = stub;
  }
  return { originals, freedTokens: Math.floor(freed / 4) };
}

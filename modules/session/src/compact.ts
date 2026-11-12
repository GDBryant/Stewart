import type { AgentDef } from "@stewart/config";
import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";

/** Context window assumed when the model's is unknown. */
const DEFAULT_WINDOW = 32_768;
/** Compact when the transcript is estimated past this share of the window. */
const THRESHOLD = 0.6;
/** User-started turns kept verbatim (the last one is the open task). */
const KEEP_TURNS = 2;
const TOOL_SNIPPET = 400;
const SOURCE_CAP = 40_000;
export const SUMMARY_PREFIX = "[Summary of earlier conversation]";

const SUMMARY_SYSTEM =
  "Summarise the conversation so far for an agent that will continue it. Keep: the user's goals and decisions, files read or changed (with paths), commands run and their results, open questions and next steps. Be factual and under 400 words.";

function size(m: ChatMessage): number {
  const extra = m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
  return m.content.length + extra;
}

/** Rough token estimate (4 chars per token). */
export function estimateTokens(transcript: ChatMessage[]): number {
  return Math.ceil(transcript.reduce((n, m) => n + size(m), 0) / 4);
}

/** Index where the kept tail starts: the KEEP_TURNS-th user message from the end; -1 when there is nothing older to summarise. */
export function cutIndex(transcript: ChatMessage[]): number {
  let seen = 0;
  for (let i = transcript.length - 1; i > 0; i--) {
    if (transcript[i].role === "user" && !transcript[i].content.startsWith("[image from")) {
      seen++;
      if (seen === KEEP_TURNS) return i;
    }
  }
  return -1;
}

function render(older: ChatMessage[]): string {
  const lines = older.map((m) => {
    const body = m.role === "tool" ? m.content.slice(0, TOOL_SNIPPET) : m.content;
    const calls = m.role === "assistant" && m.toolCalls?.length ? ` [calls: ${m.toolCalls.map((c) => c.name).join(", ")}]` : "";
    return `${m.role}${calls}: ${body}`;
  });
  return lines.join("\n").slice(-SOURCE_CAP);
}

async function summarise(channel: ManagedChannel, agent: AgentDef, older: ChatMessage[], signal: AbortSignal): Promise<string> {
  const messages = [
    { role: "system" as const, content: SUMMARY_SYSTEM },
    { role: "user" as const, content: render(older) },
  ];
  let text = "";
  for await (const ev of channel.chat({ model: agent.model, messages, signal })) if (ev.kind === "text") text += ev.text;
  return text.trim();
}

export interface CompactArgs {
  host: Pick<HostPort, "files" | "log">;
  transcript: ChatMessage[];
  channel: ManagedChannel;
  agent: AgentDef;
  /** Usable window in tokens; undefined = unknown. */
  window?: number;
  /** Where removed messages are archived (JSON lines). */
  archivePath: string;
  signal: AbortSignal;
}

/**
 * One-step compaction: when the transcript passes the threshold, replace everything before the last
 * KEEP_TURNS user turns with one summary message. The removed messages are archived first; a failed
 * or empty summary leaves the transcript untouched. Returns true when it compacted.
 */
export async function compactTranscript(a: CompactArgs): Promise<boolean> {
  const limit = Math.floor((a.window ?? DEFAULT_WINDOW) * THRESHOLD);
  if (estimateTokens(a.transcript) <= limit) return false;
  const cut = cutIndex(a.transcript);
  if (cut <= 0) return false;
  const older = a.transcript.slice(0, cut);
  let summary: string;
  try {
    summary = await summarise(a.channel, a.agent, older, a.signal);
  } catch (e) {
    a.host.log(`compaction skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (!summary) return false;
  try {
    for (const m of older) await a.host.files.appendLine(a.archivePath, JSON.stringify(m));
  } catch (e) {
    a.host.log(`compaction skipped (archive failed): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  a.transcript.splice(0, cut, { role: "user", content: `${SUMMARY_PREFIX}\n${summary}` });
  return true;
}

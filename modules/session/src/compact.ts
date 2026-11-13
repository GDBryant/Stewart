import type { AgentDef } from "@stewart/config";
import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";

/** Context window assumed when the model's is unknown. */
const DEFAULT_WINDOW = 32_768;
/** Compact when the transcript is estimated past this share of the window. */
const THRESHOLD = 0.6;
/** User-started turns kept verbatim (the last one is the open task). */
const KEEP_TURNS = 2;
/** Within one long turn: messages kept verbatim after the open task. */
const KEEP_TAIL = 8;
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
    if (transcript[i].role === "user" && !transcript[i].content.startsWith("[image from") && !transcript[i].content.startsWith(SUMMARY_PREFIX)) {
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
  /** Where removed messages are archived (JSON lines `{chunk, message}`). */
  archivePath: string;
  signal: AbortSignal;
  /** Chunk id for the archive (default: time-based). */
  chunkId?: string;
}

/** Index of the last real user message (the open task), or -1. */
function lastUserIndex(transcript: ChatMessage[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "user" && !m.content.startsWith("[image from") && !m.content.startsWith(SUMMARY_PREFIX)) return i;
  }
  return -1;
}

/** Start of the kept tail inside the open turn: an assistant message, at most KEEP_TAIL from the end; -1 when nothing to cut. */
export function tailIndex(transcript: ChatMessage[]): number {
  const u = lastUserIndex(transcript);
  if (u < 0) return -1;
  for (let i = Math.max(u + 2, transcript.length - KEEP_TAIL); i < transcript.length; i++) {
    if (transcript[i].role === "assistant") return i;
  }
  return -1;
}

/**
 * The range to summarise: older turns first; within one long turn, the work between the task and the tail —
 * only when that frees at least half the estimate (a large tail alone would otherwise re-summarise every request).
 */
function pickRange(transcript: ChatMessage[]): { from: number; to: number } | undefined {
  const cut = cutIndex(transcript);
  if (cut > 0 && transcript.slice(0, cut).some((m) => !m.content.startsWith(SUMMARY_PREFIX))) return { from: 0, to: cut };
  const tail = tailIndex(transcript);
  const u = lastUserIndex(transcript);
  if (tail <= u + 1) return undefined;
  const freed = estimateTokens(transcript.slice(u + 1, tail));
  return freed * 2 >= estimateTokens(transcript) ? { from: u + 1, to: tail } : undefined;
}

async function archive(a: CompactArgs, chunk: string, older: ChatMessage[]): Promise<void> {
  for (const message of older) await a.host.files.appendLine(a.archivePath, JSON.stringify({ chunk, message }));
}

/**
 * One-step compaction: when the transcript passes the threshold, replace one range with one summary message:
 * everything before the last KEEP_TURNS user turns, or (inside one long turn) the work between the open task
 * and the last few messages. The removed messages are archived first; a failed or empty summary leaves the
 * transcript untouched. Returns true when it compacted.
 */
export async function compactTranscript(a: CompactArgs): Promise<boolean> {
  const limit = Math.floor((a.window ?? DEFAULT_WINDOW) * THRESHOLD);
  if (estimateTokens(a.transcript) <= limit) return false;
  const range = pickRange(a.transcript);
  if (!range) return false;
  const older = a.transcript.slice(range.from, range.to);
  let summary: string;
  try {
    summary = await summarise(a.channel, a.agent, older, a.signal);
  } catch (e) {
    a.host.log(`compaction skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (!summary) return false;
  const chunk = a.chunkId ?? `c${Date.now().toString(36)}`;
  try {
    await archive(a, chunk, older);
  } catch (e) {
    a.host.log(`compaction skipped (archive failed): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  a.transcript.splice(range.from, range.to - range.from, { role: "user", content: `${SUMMARY_PREFIX} #${chunk}\n${summary}` });
  return true;
}

const SUMMARY_ID = /^\[Summary of earlier conversation\] #(\S+)/;

async function readChunks(host: Pick<HostPort, "files">, archivePath: string): Promise<Map<string, ChatMessage[]>> {
  const chunks = new Map<string, ChatMessage[]>();
  if (!(await host.files.exists(archivePath))) return chunks;
  for (const line of await host.files.readLines(archivePath)) {
    try {
      const { chunk, message } = JSON.parse(line) as { chunk?: string; message?: ChatMessage };
      if (!chunk || !message) continue;
      chunks.set(chunk, [...(chunks.get(chunk) ?? []), message]);
    } catch {
      /* a torn line is skipped */
    }
  }
  return chunks;
}

function expand(transcript: ChatMessage[], chunks: Map<string, ChatMessage[]>, depth = 0): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of transcript) {
    const id = m.role === "user" ? SUMMARY_ID.exec(m.content)?.[1] : undefined;
    const body = id ? chunks.get(id) : undefined;
    if (body && depth < 20) out.push(...expand(body, chunks, depth + 1));
    else out.push(m);
  }
  return out;
}

/** The full transcript for display: every compaction summary replaced by the messages it archived. */
export async function expandArchived(host: Pick<HostPort, "files">, transcript: ChatMessage[], archivePath: string): Promise<ChatMessage[]> {
  try {
    const chunks = await readChunks(host, archivePath);
    return chunks.size ? expand(transcript, chunks) : transcript;
  } catch {
    return transcript;
  }
}

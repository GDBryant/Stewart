import type { AgentDef } from "@stewart/config";
import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import { applyOutbound } from "@stewart/business-policy";
import { TRIM_MARK, trimOldResults } from "./compactTrim.js";

/** Context window assumed when the model's is unknown. */
const DEFAULT_WINDOW = 32_768;
/** Compact when the transcript is estimated past this share of the window. */
const THRESHOLD = 0.6;
/** User-started turns kept verbatim (the last one is the open task). */
const KEEP_TURNS = 2;
/** Within one long turn: messages kept verbatim after the open task. */
const KEEP_TAIL = 8;
const TOOL_SNIPPET = 400;
/** A file read keeps this much in the summariser input, so the "Files read" digest can name symbols. */
const READ_SNIPPET = 1500;
/** After a model summary, no new one within this many requests unless the estimate passes `HARD`. */
const COOLDOWN = 4;
const HARD = 0.9;
/** When a summary still leaves the transcript above the threshold, a second trim pass keeps this many messages whole and stubs to this many chars. */
const SECOND_KEEP = 2;
const SECOND_CAP = 800;
const SOURCE_CAP = 40_000;
export const SUMMARY_PREFIX = "[Summary of earlier conversation]";

const SUMMARY_SYSTEM =
  "Summarise the conversation so far for an agent that will continue it. Keep: the user's goals and decisions, files changed (with paths), commands run and their results, open questions and next steps. Then add a 'Files read' list: one line per file with its path, its purpose and key symbols (functions, classes, constants), so the agent does not need to read it again. Be factual and under 500 words.";

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

/** Tool-call id → "name path" for the calls in `older`, so a result can be labelled and a file read kept longer. */
function callLabels(older: ChatMessage[]): Map<string, { label: string; read: boolean }> {
  const out = new Map<string, { label: string; read: boolean }>();
  for (const m of older) {
    if (m.role !== "assistant") continue;
    for (const c of m.toolCalls ?? []) {
      const path = typeof c.arguments.path === "string" ? ` ${c.arguments.path}` : "";
      out.set(c.id, { label: `${c.name}${path}`, read: c.name === "ReadFile" || c.name === "Read" });
    }
  }
  return out;
}

function render(older: ChatMessage[]): string {
  const calls = callLabels(older);
  const lines = older.map((m) => {
    const info = m.role === "tool" ? calls.get(m.toolCallId ?? "") : undefined;
    const body = m.role === "tool" ? m.content.slice(0, info?.read ? READ_SNIPPET : TOOL_SNIPPET) : m.content;
    const called = m.role === "assistant" && m.toolCalls?.length ? ` [calls: ${m.toolCalls.map((c) => c.name).join(", ")}]` : "";
    const tag = info ? ` [${info.label}]` : "";
    return `${m.role}${called}${tag}: ${body}`;
  });
  return lines.join("\n").slice(-SOURCE_CAP);
}

/** Business policy for the summary request: tool results with a match are withheld, other matching messages are blanked (the archive keeps the originals). */
function safeOlder(channel: ManagedChannel, older: ChatMessage[]): ChatMessage[] {
  const out = applyOutbound(older, [...channel.policyRules]);
  const bad = new Set(out.blocked.map((v) => v.msgIndex));
  const blank = (m: ChatMessage): ChatMessage => ({ role: m.role === "assistant" ? "assistant" : "user", content: "[message withheld by business policy]" });
  return out.messages.map((m, i) => (bad.has(i) ? blank(m) : m));
}

async function summarise(channel: ManagedChannel, agent: AgentDef, older: ChatMessage[], signal: AbortSignal): Promise<string> {
  const messages = [
    { role: "system" as const, content: SUMMARY_SYSTEM },
    { role: "user" as const, content: render(safeOlder(channel, older)) },
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
  /** The provider's prompt-token count for an earlier request that covered `transcript.slice(0, len)`; preferred over the 4 chars/token estimate. */
  measured?: { tokens: number; len: number };
  /** Cooldown bookkeeping, owned by the caller and mutated here; absent = no cooldown. */
  state?: CompactState;
}

/** Requests since the last model summary. */
export interface CompactState {
  sinceSummary: number;
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

/** Appends messages to the archive; `trimmed` lines hold the originals of tool results later shortened in place. */
async function archive(a: CompactArgs, chunk: string, older: ChatMessage[], trimmed = false): Promise<void> {
  for (const message of older) await a.host.files.appendLine(a.archivePath, JSON.stringify({ chunk, message, ...(trimmed ? { trimmed: true } : {}) }));
}

/** Current prompt size: the last measured count plus the estimate of what was appended since, else the plain estimate. */
export function currentTokens(a: Pick<CompactArgs, "transcript" | "measured">): number {
  const m = a.measured;
  return m && m.len <= a.transcript.length ? m.tokens + estimateTokens(a.transcript.slice(m.len)) : estimateTokens(a.transcript);
}

/** Trims old tool results in place (originals archived first); returns the tokens freed, 0 when nothing changed or the archive failed. */
async function trimPass(a: CompactArgs, keepRecent?: number, cap?: number): Promise<number> {
  const probe = a.transcript.map((m) => ({ ...m }));
  const { originals, freedTokens } = trimOldResults(probe, keepRecent, cap);
  if (!originals.length) return 0;
  try {
    await archive(a, `t${Date.now().toString(36)}`, originals, true);
  } catch (e) {
    a.host.log(`trim skipped (archive failed): ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  trimOldResults(a.transcript, keepRecent, cap);
  return freedTokens;
}

/** One model summary of the chosen range; false when there is no range, the summary failed or was empty, or the archive failed. */
async function summarisePass(a: CompactArgs): Promise<boolean> {
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

/** True within `COOLDOWN` requests of the last model summary, unless the prompt is past `HARD` of the window. */
function coolingDown(state: CompactState | undefined, tokens: number, window: number): boolean {
  return state !== undefined && state.sinceSummary <= COOLDOWN && tokens <= window * HARD;
}

/**
 * Compaction when the prompt (measured, else estimated) passes the threshold: (1) trim old tool results to stubs —
 * no model call; (2) if still over, and not within `COOLDOWN` requests of the last summary (unless past `HARD` of the
 * window), replace one range with one model summary, then (3) if that still leaves it over, a second, harder trim.
 * Removed content is archived first; a failed or empty summary leaves the transcript as step 1 left it.
 * Returns true when the transcript changed.
 */
export async function compactTranscript(a: CompactArgs): Promise<boolean> {
  const window = a.window ?? DEFAULT_WINDOW;
  const limit = Math.floor(window * THRESHOLD);
  if (a.state) a.state.sinceSummary++;
  let cur = currentTokens(a);
  if (cur <= limit) return false;
  const freed = await trimPass(a);
  cur -= freed;
  if (cur <= limit) return freed > 0;
  if (coolingDown(a.state, cur, window)) return freed > 0;
  if (!(await summarisePass(a))) return freed > 0;
  if (a.state) a.state.sinceSummary = 0;
  if (estimateTokens(a.transcript) > limit) await trimPass(a, SECOND_KEEP, SECOND_CAP);
  return true;
}

const SUMMARY_ID = /^\[Summary of earlier conversation\] #(\S+)/;

interface Archive {
  /** Summarised ranges by chunk id. */
  chunks: Map<string, ChatMessage[]>;
  /** Original tool results shortened in place, by tool-call id (a provider may reuse ids, so several). */
  originals: Map<string, ChatMessage[]>;
}

const callId = (m: ChatMessage): string => (m.role === "tool" ? m.toolCallId : "");

async function readArchive(host: Pick<HostPort, "files">, archivePath: string): Promise<Archive> {
  const out: Archive = { chunks: new Map(), originals: new Map() };
  if (!(await host.files.exists(archivePath))) return out;
  for (const line of await host.files.readLines(archivePath)) {
    try {
      const { chunk, message, trimmed } = JSON.parse(line) as { chunk?: string; message?: ChatMessage; trimmed?: boolean };
      if (!chunk || !message) continue;
      if (trimmed) {
        const id = callId(message);
        out.originals.set(id, [...(out.originals.get(id) ?? []), message]);
      } else out.chunks.set(chunk, [...(out.chunks.get(chunk) ?? []), message]);
    } catch {
      /* a torn line is skipped */
    }
  }
  return out;
}

/** A trimmed tool result with its original put back (matched by call id and the stub's kept head); other messages pass through. */
function restore(m: ChatMessage, originals: Map<string, ChatMessage[]>): ChatMessage {
  const at = m.role === "tool" ? m.content.indexOf(`\n${TRIM_MARK}`) : -1;
  if (at < 0) return m;
  const head = m.content.slice(0, at);
  const orig = originals.get(callId(m))?.find((o) => o.content.startsWith(head));
  return orig ?? m;
}

function expand(transcript: ChatMessage[], arc: Archive, depth = 0): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of transcript) {
    const id = m.role === "user" ? SUMMARY_ID.exec(m.content)?.[1] : undefined;
    const body = id ? arc.chunks.get(id) : undefined;
    if (body && depth < 20) out.push(...expand(body, arc, depth + 1));
    else out.push(restore(m, arc.originals));
  }
  return out;
}

/** The full transcript for display: every compaction summary replaced by the messages it archived, and every trimmed tool result by its original. */
export async function expandArchived(host: Pick<HostPort, "files">, transcript: ChatMessage[], archivePath: string): Promise<ChatMessage[]> {
  try {
    const arc = await readArchive(host, archivePath);
    return arc.chunks.size || arc.originals.size ? expand(transcript, arc) : transcript;
  } catch {
    return transcript;
  }
}

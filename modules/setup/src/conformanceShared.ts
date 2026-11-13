import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { ChannelDef, Qual } from "@stewart/config";
import { resolveModelProfile } from "@stewart/models";
import type { ManagedChannel } from "@stewart/channels";
import type { Engine } from "@stewart/engines";

export const CONFORMANCE_VERSION = 2;
export const AGENT_MIN_CONTEXT = 32_000;
export const AGENT_TIMEOUT_MS = 120_000;
export const AGENT_PROMPT =
  "Read notes/todo.txt, add the line gamma at the end of the file, then run `wc -l notes/todo.txt` and tell me the number it printed.";

export interface QualifyDeps {
  engine?: Engine;
  clock: { now(): number };
  sleep?: (ms: number) => Promise<void>;
  /** Real scratch directory for engines that run on disk (claude-cli). */
  scratch?: { host: HostPort; dir: string };
}

export function qual(passed: boolean, now: number, detail?: string): Qual {
  return { passed, at: now, version: CONFORMANCE_VERSION, detail };
}

function lastText(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

export function agentCriteria(content: string, wcOk: boolean, transcript: ChatMessage[]): string | undefined {
  if (content !== "alpha\nbeta\ngamma\n" && content !== "alpha\nbeta\ngamma")
    return `file not edited to expected content: ${JSON.stringify(content.length > 120 ? `${content.slice(0, 120)}…` : content)}`;
  if (!wcOk) return "no successful `wc` RunTerminal call";
  if (!lastText(transcript).includes("3")) return "reply does not contain the wc count 3";
  return undefined;
}

/** Probe message ≈ 28k real tokens: a 32k-class window must hold it plus the reply. */
export const PROBE_MIN_CHARS = 84_000;
const USAGE_MIN_TOKENS = 20_000;
const PROBE_WORD = "quillfeather";

/** Probe message: the code word on line 1, then numbered filler lines. */
export function probeMessage(): string {
  const head = `The code word is ${PROBE_WORD}.\n`;
  const tail = "\nReply with only the code word from the first line.";
  const parts: string[] = [head];
  let len = head.length + tail.length;
  for (let i = 1; len < PROBE_MIN_CHARS; i++) {
    const line = `line ${i}: lorem ipsum dolor sit amet\n`;
    len += line.length;
    parts.push(line);
  }
  return parts.join("") + tail;
}

/** One probe message in, the reply text (and truncation flag) out — channel.chat or an engine turn. */
export type ProbeTransport = (message: string) => Promise<{ text: string; truncated?: boolean; usageIn?: number }>;

/** The channel.chat transport: one no-tools request with the suite timeout. */
export function channelProbe(channel: ManagedChannel, model: string): ProbeTransport {
  return async (message) => {
    let text = "";
    let truncated = false;
    let usageIn: number | undefined;
    for await (const ev of channel.chat({ model, messages: [{ role: "user", content: message }], signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) })) {
      if (ev.kind === "text") text += ev.text;
      if (ev.kind === "done") {
        truncated = ev.truncated === true;
        usageIn = ev.usage?.in;
      }
    }
    return { text, truncated, usageIn };
  };
}

/** Window probe: the model must echo a word from the top of a ≈28k-token message; undefined = pass. */
async function windowProbe(transport: ProbeTransport): Promise<string | undefined> {
  let reply: { text: string; truncated?: boolean; usageIn?: number };
  try {
    reply = await transport(probeMessage());
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (reply.truncated) return "reply truncated";
  if (reply.usageIn !== undefined && reply.usageIn < USAGE_MIN_TOKENS)
    return `prompt truncated by provider (${reply.usageIn} tokens evaluated)`;
  if (!reply.text.toLowerCase().includes(PROBE_WORD)) return "code word not echoed";
  return undefined;
}

/** The passing record's verified window: the known one, or AGENT_MIN_CONTEXT after a successful probe. */
export async function contextQual(ch: ChannelDef, model: string, now: number, io: { channel: ManagedChannel; transport?: ProbeTransport }): Promise<Qual> {
  const known = resolveModelProfile({ channels: [ch] }, { channel: ch.id, model }).contextTokens;
  if (known !== undefined) return { ...qual(true, now), context: known };
  const reason = await windowProbe(io.transport ?? channelProbe(io.channel, model));
  return reason === undefined
    ? { ...qual(true, now), context: AGENT_MIN_CONTEXT }
    : qual(false, now, `context window below ${AGENT_MIN_CONTEXT} (window probe failed: ${reason})`);
}

import type { FetchResponse, ToolCall } from "@stewart/kernel";
import type { ChannelDeps, ChatEvent } from "./types.js";
import { ChannelError } from "./types.js";

const decoder = new TextDecoder();

function nextChunk(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("stream stall timeout")), stallMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function drainBuffer(buf: string): { lines: string[]; rest: string } {
  const out: string[] = [];
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) out.push(line);
  }
  return { lines: out, rest: buf };
}

/** Iterate complete lines from a byte stream. Enforces stall timeout between chunks. */
export async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal, stallMs: number): AsyncGenerator<string> {
  const reader = body.getReader();
  let buf = "";
  try {
    for (;;) {
      const result = await nextChunk(reader, stallMs);
      if (result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      const d = drainBuffer(buf);
      buf = d.rest;
      yield* d.lines;
      if (signal.aborted) return;
    }
    const tail = buf.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Parse one SSE line group: yields each `data:` payload, skipping `[DONE]`. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal, stallMs: number): AsyncGenerator<string> {
  for await (const line of lines(body, signal, stallMs)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    if (data) yield data;
  }
}

/** Normalized per-line deltas decoded from a provider's wire format. */
export type WireDelta =
  | { t: "text"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "tool_fragment"; index?: number; id?: string; name?: string; args?: string }
  | { t: "tool_calls"; calls: { id?: string; name: string; arguments: Record<string, unknown> }[] }
  | { t: "usage"; usage: { in: number; out: number }; costUsd?: number }
  | { t: "truncated" };

/**
 * Accumulates wire deltas into ChatEvents. Text/reasoning pass through immediately;
 * tool-call fragments merge by index; finish() emits pending tool_calls then done.
 */
export class StreamAccumulator {
  private partial: { id: string; name: string; args: string }[] = [];
  private complete: ToolCall[] = [];
  private usage: { in: number; out: number } | undefined;
  private costUsd: number | undefined;
  private truncated = false;

  /** Last usage seen, for provider-specific post-processing (e.g. ollama truncation warnings). */
  get sawUsage(): { in: number; out: number } | undefined {
    return this.usage;
  }

  /** Returns ChatEvents to emit immediately (text/reasoning pass through; the rest accumulate). */
  apply(d: WireDelta): ChatEvent[] {
    switch (d.t) {
      case "text":
      case "reasoning":
        return [{ kind: d.t, text: d.text }];
      case "tool_fragment":
        this.applyFragment(d);
        return [];
      case "tool_calls":
        this.applyCalls(d.calls);
        return [];
      case "usage":
        this.usage = d.usage;
        if (d.costUsd !== undefined) this.costUsd = d.costUsd;
        return [];
      case "truncated":
        this.truncated = true;
        return [];
    }
  }

  private applyFragment(d: Extract<WireDelta, { t: "tool_fragment" }>): void {
    const i = d.index ?? this.partial.length;
    if (!this.partial[i]) this.partial[i] = { id: d.id ?? `call_${i}`, name: "", args: "" };
    if (d.id) this.partial[i].id = d.id;
    if (d.name) this.partial[i].name += d.name;
    if (d.args) this.partial[i].args += d.args;
  }

  private applyCalls(calls: Extract<WireDelta, { t: "tool_calls" }>["calls"]): void {
    for (const c of calls) {
      this.complete.push({ id: c.id ?? `call_${this.complete.length}`, name: c.name, arguments: c.arguments });
    }
  }

  /** Emits accumulated tool_calls (if any) then the done event. */
  finish(): ChatEvent[] {
    const calls = this.complete.length
      ? this.complete
      : this.partial.filter((p) => p.name).map((p) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(p.args || "{}");
          } catch {
            /* fail closed: drop unparseable args */
          }
          return { id: p.id, name: p.name, arguments: args };
        });
    const out: ChatEvent[] = [];
    if (calls.length) out.push({ kind: "tool_calls", calls });
    out.push({ kind: "done", usage: this.usage, costUsd: this.costUsd, truncated: this.truncated });
    return out;
  }
}

/**
 * POST a chat request and return the streaming body. Handles connection errors,
 * non-200 statuses (429 → ChannelError with retry-after), debug records, empty bodies.
 */
export async function postForStream(
  deps: ChannelDeps,
  provider: string,
  model: string,
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; body: string },
  describeError: (status: number, body: string) => ChannelError,
): Promise<ReadableStream<Uint8Array>> {
  const dbg = deps.debug;
  let r: FetchResponse;
  try {
    r = await deps.fetcher(url, { method: "POST", headers: init.headers, signal: init.signal, body: init.body });
  } catch (e) {
    dbg?.record({ direction: "error", provider, model, payload: `connection failed: ${e instanceof Error ? e.message : String(e)}` });
    throw e;
  }
  if (r.status !== 200) {
    const text = await new Response(r.body).text();
    dbg?.record({ direction: "error", provider, model, payload: `HTTP ${r.status}: ${text}` });
    if (r.status === 429) throw new ChannelError("rate limited", 429, Number(r.headers["retry-after"] ?? 1) * 1000);
    throw describeError(r.status, text);
  }
  if (!r.body) throw new ChannelError("empty response body");
  return r.body;
}

import type { ChannelAdapter, ChannelConfig, ChannelDeps, ChatEvent, ChatRequest } from "./types.js";
import { ChannelError } from "./types.js";
import type { DebugSink } from "@stewart/diagnostics";
import { lines, postForStream, StreamAccumulator, type WireDelta } from "./stream.js";

function url(cfg: ChannelConfig, path: string): string {
  return (cfg.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "") + path;
}

/** v1 extractError: JSON `error` string wins; JSON with non-string error falls back to raw body; empty falls back to status text. */
export function extractError(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
    return body;
  } catch {
    return body;
  }
}

type OllamaToolCall = { id?: string; function: { name: string; arguments: Record<string, unknown> } };
type OllamaLine = {
  error?: unknown;
  message?: unknown;
  done?: unknown;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

function toOllamaMessages(req: ChatRequest) {
  return req.messages.map((m) => {
    if (m.role === "tool") return { role: "tool", content: m.content };
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content, tool_calls: m.toolCalls?.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) };
    }
    return { role: m.role, content: m.content, images: m.images };
  });
}

function ollamaMessage(m: { content?: unknown; thinking?: string; tool_calls?: OllamaToolCall[] } | null | undefined, out: WireDelta[]): void {
  if (typeof m?.content === "string" && m.content) out.push({ t: "text", text: m.content });
  if (m?.thinking) out.push({ t: "reasoning", text: m.thinking });
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    out.push({ t: "tool_calls", calls: m.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })) });
  }
}

function ollamaDone(j: OllamaLine, out: WireDelta[]): void {
  if (j.done !== true) return;
  out.push({ t: "usage", usage: { in: j.prompt_eval_count ?? 0, out: j.eval_count ?? 0 } });
  if (j.done_reason === "length") out.push({ t: "truncated" });
}

function parseOllamaLine(line: string): OllamaLine {
  try {
    return JSON.parse(line);
  } catch {
    throw new ChannelError(`malformed NDJSON line: ${line.slice(0, 80)}`); // v1: malformed → Failed
  }
}

/** Decode one NDJSON line into normalized wire deltas. Throws ChannelError on provider error lines. */
function ollamaDeltas(j: OllamaLine): WireDelta[] {
  if (j.error !== undefined) throw new ChannelError(String(j.error));
  const m = j.message as { content?: unknown; thinking?: string; tool_calls?: OllamaToolCall[] } | null | undefined;
  if (m !== undefined && m !== null && typeof m !== "object") throw new ChannelError("invalid message field");
  const out: WireDelta[] = [];
  ollamaMessage(m, out);
  ollamaDone(j, out);
  return out;
}

/** Warn when the provider evaluated far fewer prompt tokens than sent (num_ctx truncation). */
function warnIfTruncated(acc: StreamAccumulator, estTokens: number, numCtx: number | undefined, dbg: DebugSink | undefined, provider: string, model: string): void {
  const u = acc.sawUsage;
  if (u && u.in > 0 && u.in < estTokens * 0.6) {
    dbg?.record({
      direction: "error",
      provider,
      model,
      payload: `prompt truncated by provider: ~${estTokens} tokens sent, ${u.in} evaluated (num_ctx=${numCtx ?? "default"}); raise numCtx`,
    });
  }
}

/** Ollama channel: NDJSON streaming, /api/tags + /api/show probes. */
export class OllamaAdapter implements ChannelAdapter {
  readonly type = "ollama";
  constructor(private deps: ChannelDeps) {}

  async listModels(cfg: ChannelConfig): Promise<string[]> {
    const r = await this.deps.fetcher(url(cfg, "/api/tags"), {});
    if (r.status !== 200) throw new ChannelError(`GET /api/tags → ${r.status}`, r.status);
    const text = await new Response(r.body).text();
    const names = (JSON.parse(text).models ?? []).map((m: { name: string }) => m.name) as string[];
    return [...new Set([...names, ...(cfg.extraModels ?? [])])];
  }

  async probeCaps(cfg: ChannelConfig, _secret: string | undefined, model: string): Promise<Partial<import("@stewart/models").ModelCaps>> {
    const r = await this.deps.fetcher(url(cfg, "/api/show"), { method: "POST", body: JSON.stringify({ model }) });
    if (r.status !== 200) throw new ChannelError(`POST /api/show → ${r.status}`, r.status);
    const info = JSON.parse(await new Response(r.body).text());
    const caps: string[] = info.capabilities ?? [];
    return {
      tools: caps.includes("tools") ? "native" : "shim",
      vision: caps.includes("vision"),
      reasoning: caps.includes("thinking"),
      contextTokens: info.model_info?.["general.context_length"] ?? undefined,
    };
  }

  async *chat(cfg: ChannelConfig, _secret: string | undefined, req: ChatRequest): AsyncIterable<ChatEvent> {
    const tools = req.tools?.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    const messages = toOllamaMessages(req);
    const dbg = this.deps.debug;
    const caps = cfg.modelCaps?.[req.model];
    const estTokens = estimatePromptTokens(messages, tools);
    const numCtx = caps?.numCtx ?? autoNumCtx(estTokens, caps?.contextTokens);
    const body = JSON.stringify({
      model: req.model,
      messages,
      tools: tools?.length ? tools : undefined,
      stream: true,
      options: { temperature: req.temperature, num_ctx: numCtx },
    });
    dbg?.record({ direction: "outgoing", provider: this.type, model: req.model, payload: `num_ctx=${numCtx ?? "default"} ${body}` });
    const stream = await postForStream(
      this.deps,
      this.type,
      req.model,
      url(cfg, "/api/chat"),
      { headers: { "content-type": "application/json" }, signal: req.signal, body },
      (status, text) => new ChannelError(extractError(text, `POST /api/chat → ${status}`), status), // v1: extractError
    );
    const acc = new StreamAccumulator();
    let sawDone = false;
    try {
      sawDone = yield* this.ollamaLines(stream, req, acc, dbg, estTokens, numCtx);
    } catch (e) {
      dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    if (!sawDone && !req.signal.aborted) dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: "stream ended before done" });
    yield* acc.finish();
  }

  private async *ollamaLines(stream: ReadableStream<Uint8Array>, req: ChatRequest, acc: StreamAccumulator, dbg: DebugSink | undefined, estTokens: number, numCtx: number | undefined): AsyncGenerator<ChatEvent, boolean> {
    for await (const line of lines(stream, req.signal, this.deps.stallTimeoutMs ?? 60_000)) {
      dbg?.record({ direction: "incoming", provider: this.type, model: req.model, payload: line });
      const j = parseOllamaLine(line);
      for (const d of ollamaDeltas(j)) yield* acc.apply(d);
      if (j.done === true) {
        warnIfTruncated(acc, estTokens, numCtx, dbg, this.type, req.model);
        return true;
      }
    }
    return false;
  }
}

/** Rough prompt size (~3.5 chars/token, incl. JSON overhead). */
export function estimatePromptTokens(messages: unknown, tools: unknown): number {
  return Math.ceil((JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)) / 3.5);
}

const MIN_AUTO_CTX = 4096;
const MAX_AUTO_CTX = 32768;

/** Ollama's default context silently drops the oldest prompt content; size num_ctx to fit when none is configured. */
export function autoNumCtx(estTokens: number, modelMax?: number): number | undefined {
  if (estTokens * 1.25 <= 2048) return undefined;
  const want = Math.ceil((estTokens * 1.25 + 1024) / 1024) * 1024;
  const cap = Math.min(MAX_AUTO_CTX, modelMax && modelMax > 0 ? modelMax : MAX_AUTO_CTX);
  return Math.max(Math.min(want, cap), Math.min(MIN_AUTO_CTX, cap));
}

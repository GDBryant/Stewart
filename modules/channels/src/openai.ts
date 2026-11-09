import type { ChannelAdapter, ChannelConfig, ChannelDeps, ChatEvent, ChatRequest } from "./types.js";
import { ChannelError } from "./types.js";
import { postForStream, sseData, StreamAccumulator, type WireDelta } from "./stream.js";

function url(cfg: ChannelConfig, path: string): string {
  // Join without doubling /v1 style suffixes.
  const base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
  return base + path;
}

type Delta = {
  content?: string;
  reasoning_content?: string;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

type OpenAIChunk = {
  choices?: { delta?: Delta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

function toOpenAIMessages(req: ChatRequest) {
  return req.messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content || null, tool_calls: m.toolCalls?.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) };
    }
    if (m.images?.length) {
      return { role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((b64) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }))] };
    }
    return { role: m.role, content: m.content };
  });
}

/** Decode one SSE chunk into normalized wire deltas. */
function openAiDeltas(j: OpenAIChunk): WireDelta[] {
  const out: WireDelta[] = [];
  const d = j.choices?.[0]?.delta;
  if (d?.reasoning_content) out.push({ t: "reasoning", text: d.reasoning_content });
  if (d?.content) out.push({ t: "text", text: d.content });
  if (d?.tool_calls) {
    for (const tc of d.tool_calls) {
      out.push({ t: "tool_fragment", index: tc.index, id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
    }
  }
  if (j.choices?.[0]?.finish_reason === "length") out.push({ t: "truncated" });
  if (j.usage) {
    out.push({
      t: "usage",
      usage: { in: j.usage.prompt_tokens ?? 0, out: j.usage.completion_tokens ?? 0 },
      costUsd: typeof j.usage.cost === "number" ? j.usage.cost : undefined,
    });
  }
  return out;
}

/** OpenAI-compatible channel: SSE streaming, GET /models, dummy-tool capability probe. */
export class OpenAICompatAdapter implements ChannelAdapter {
  readonly type = "openai-compatible";
  constructor(private deps: ChannelDeps) {}

  private headers(cfg: ChannelConfig, secret: string | undefined): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = secret ?? (cfg.apiKey as string | undefined);
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  async listModels(cfg: ChannelConfig, secret: string | undefined): Promise<string[]> {
    const r = await this.deps.fetcher(url(cfg, "/models"), { headers: this.headers(cfg, secret) });
    if (r.status !== 200) throw new ChannelError(`GET /models → ${r.status}`, r.status);
    const j = JSON.parse(await new Response(r.body).text());
    const names = (j.data ?? []).map((m: { id: string }) => m.id) as string[];
    return [...new Set([...names, ...(cfg.extraModels ?? [])])];
  }

  /** OpenRouter-style /models entries carry pricing.{prompt,completion} as USD-per-token strings. */
  async priceList(cfg: ChannelConfig, secret: string | undefined): Promise<Record<string, { inPerMTok: number; outPerMTok: number }> | undefined> {
    const r = await this.deps.fetcher(url(cfg, "/models"), { headers: this.headers(cfg, secret) });
    if (r.status !== 200) throw new ChannelError(`GET /models → ${r.status}`, r.status);
    const j = JSON.parse(await new Response(r.body).text());
    const out: Record<string, { inPerMTok: number; outPerMTok: number }> = {};
    for (const m of (j.data ?? []) as { id?: string; pricing?: { prompt?: string; completion?: string } }[]) {
      const pin = Number(m.pricing?.prompt);
      const pout = Number(m.pricing?.completion);
      if (m.id && Number.isFinite(pin) && Number.isFinite(pout) && (pin > 0 || pout > 0)) {
        out[m.id] = { inPerMTok: pin * 1e6, outPerMTok: pout * 1e6 };
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  async probeCaps(cfg: ChannelConfig, secret: string | undefined, model: string): Promise<Partial<import("@stewart/models").ModelCaps>> {
    const r = await this.deps.fetcher(url(cfg, "/chat/completions"), {
      method: "POST",
      headers: this.headers(cfg, secret),
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with ok." }],
        tools: [{ type: "function", function: { name: "noop", description: "no-op", parameters: { type: "object", properties: {} } } }],
        tool_choice: "none",
      }),
    });
    const body = await new Response(r.body).text();
    if (r.status !== 200) {
      if (r.status >= 400 && r.status < 500 && /tool|function/i.test(body)) return { tools: "none" };
      throw new ChannelError(`probe → ${r.status}: ${body.slice(0, 200)}`, r.status);
    }
    const j = JSON.parse(body);
    const msg = j.choices?.[0]?.message;
    return { tools: Array.isArray(msg?.tool_calls) ? "native" : "shim" };
  }

  async generateImage(cfg: ChannelConfig, secret: string | undefined, model: string, prompt: string): Promise<{ base64: string }> {
    const r = await this.deps.fetcher(url(cfg, "/images/generations"), {
      method: "POST",
      headers: this.headers(cfg, secret),
      body: JSON.stringify({ model, prompt, response_format: "b64_json" }),
    });
    const body = await new Response(r.body).text();
    if (r.status !== 200) throw new ChannelError(`POST /images/generations → ${r.status}: ${body.slice(0, 200)}`, r.status);
    const b64 = (JSON.parse(body).data?.[0]?.b64_json ?? null) as string | null;
    if (!b64) throw new ChannelError("image generation returned no data");
    return { base64: b64 };
  }

  async *chat(cfg: ChannelConfig, secret: string | undefined, req: ChatRequest): AsyncIterable<ChatEvent> {
    const tools = req.tools?.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    const messages = toOpenAIMessages(req);
    const dbg = this.deps.debug;
    const body = JSON.stringify({
      model: req.model,
      messages,
      tools: tools?.length ? tools : undefined,
      stream: true,
      stream_options: { include_usage: true },
      temperature: req.temperature,
    });
    dbg?.record({ direction: "outgoing", provider: this.type, model: req.model, payload: body });
    const stream = await postForStream(
      this.deps,
      this.type,
      req.model,
      url(cfg, "/chat/completions"),
      { headers: this.headers(cfg, secret), signal: req.signal, body },
      (status, text) => new ChannelError(`POST /chat/completions → ${status}: ${text.slice(0, 200)}`, status),
    );
    const acc = new StreamAccumulator();
    try {
      for await (const data of sseData(stream, req.signal, this.deps.stallTimeoutMs ?? 60_000)) {
        dbg?.record({ direction: "incoming", provider: this.type, model: req.model, payload: data });
        let j: OpenAIChunk;
        try {
          j = JSON.parse(data);
        } catch {
          continue; // fail closed on malformed chunks
        }
        for (const d of openAiDeltas(j)) yield* acc.apply(d);
      }
    } catch (e) {
      dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    yield* acc.finish();
  }
}

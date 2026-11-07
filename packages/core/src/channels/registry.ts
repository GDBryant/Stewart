import type { ChannelAdapter, ChannelConfig, ChatEvent, ChatRequest } from "./types.js";
import { DEFAULT_CAPS } from "@stewart/models";
import { ChannelError } from "./types.js";
import { stripImages } from "../images.js";

/**
 * Wraps an adapter + config with per-channel concurrency (maxParallel queue),
 * 429/Retry-After backoff, and a circuit breaker (5 consecutive failures →
 * `unhealthy`; a success or explicit reset closes it).
 */
export class ManagedChannel {
  readonly adapter: ChannelAdapter;
  readonly cfg: ChannelConfig;
  private secret: string | undefined;
  private running = 0;
  private readonly queue: { run(): Promise<void> }[] = [];
  private failures = 0;
  private backoffUntil = 0;
  private waiters: (() => void)[] = [];
  unhealthy = false;

  constructor(adapter: ChannelAdapter, cfg: ChannelConfig, secret?: string) {
    this.adapter = adapter;
    this.cfg = cfg;
    this.secret = secret;
  }

  get health(): "healthy" | "unhealthy" | "backoff" {
    if (this.unhealthy) return "unhealthy";
    if (Date.now() < this.backoffUntil) return "backoff";
    return "healthy";
  }

  setSecret(s: string | undefined): void {
    this.secret = s;
  }

  resetBreaker(): void {
    this.unhealthy = false;
    this.failures = 0;
  }

  private onSuccess(): void {
    this.failures = 0;
    this.unhealthy = false;
  }

  private onFailure(e: unknown): void {
    if (e instanceof ChannelError && e.status === 429) {
      this.backoffUntil = Date.now() + (e.retryAfterMs ?? 1000);
      return; // rate limit is not a failure
    }
    if (++this.failures >= 5) this.unhealthy = true;
  }

  /** Acquire a concurrency slot; rejects fast when unhealthy. */
  private async acquire(): Promise<void> {
    if (this.unhealthy) throw new ChannelError(`channel ${this.cfg.id} unhealthy`, 0);
    while (Date.now() < this.backoffUntil) await new Promise((r) => setTimeout(r, 50));
    if (this.running < this.cfg.maxParallel) {
      this.running++;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
    this.running++;
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    await this.acquire();
    const vision = this.cfg.modelCaps?.[req.model]?.vision ?? DEFAULT_CAPS.vision;
    if (!vision) req = { ...req, messages: stripImages(req.messages) };
    let ok = false;
    try {
      for await (const ev of this.adapter.chat(this.cfg, this.secret, req)) {
        yield ev;
        if (ev.kind === "done") ok = true;
      }
      this.onSuccess();
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) this.onFailure(e);
      throw e;
    } finally {
      this.release();
    }
    if (!ok) this.onFailure(new ChannelError("stream ended without done"));
  }

  async listModels(): Promise<string[]> {
    try {
      const m = await this.adapter.listModels(this.cfg, this.secret);
      this.onSuccess();
      return m;
    } catch (e) {
      this.onFailure(e);
      throw e;
    }
  }

  /** Image generation (imageGen models only); undefined when the adapter lacks it. */
  async generateImage(model: string, prompt: string): Promise<{ base64: string } | undefined> {
    if (!this.adapter.generateImage) return undefined;
    await this.acquire();
    try {
      const r = await this.adapter.generateImage(this.cfg, this.secret, model, prompt);
      this.onSuccess();
      return r;
    } catch (e) {
      this.onFailure(e);
      throw e;
    } finally {
      this.release();
    }
  }

  /** Live pricing when the adapter supports it; undefined when it doesn't or reports none. */
  async priceList(): Promise<Record<string, { inPerMTok: number; outPerMTok: number }> | undefined> {
    if (!this.adapter.priceList) return undefined;
    try {
      const p = await this.adapter.priceList(this.cfg, this.secret);
      this.onSuccess();
      return p;
    } catch (e) {
      this.onFailure(e);
      throw e;
    }
  }

  async probeCaps(model: string): Promise<Partial<import("@stewart/models").ModelCaps>> {
    try {
      const caps = await this.adapter.probeCaps(this.cfg, this.secret, model);
      this.onSuccess();
      return caps;
    } catch (e) {
      this.onFailure(e);
      throw e;
    }
  }
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, (deps: unknown) => ChannelAdapter>();
  register(type: string, make: (deps: unknown) => ChannelAdapter): void {
    this.adapters.set(type, make);
  }
  create(type: string, deps: unknown): ChannelAdapter {
    const make = this.adapters.get(type);
    if (!make) throw new Error(`unknown channel type: ${type}`);
    return make(deps);
  }
  types(): string[] {
    return [...this.adapters.keys()];
  }
}

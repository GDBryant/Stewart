import type { ChannelAdapter, ChannelConfig, ChatEvent, ChatRequest } from "./types.js";
import { capsFor } from "@stewart/models";
import { ChannelError, BusinessPolicyError } from "./types.js";
import { applyOutbound, type RuleId, type Violation } from "@stewart/business-policy";
import type { ChatMessage } from "@stewart/kernel";
import { stripImages } from "@stewart/kernel";
import { Semaphore } from "./semaphore.js";

/**
 * Wraps an adapter + config with per-channel concurrency (maxParallel queue),
 * 429/Retry-After backoff, and a circuit breaker (5 consecutive failures →
 * `unhealthy`; a success or explicit reset closes it).
 */
export class ManagedChannel {
  readonly adapter: ChannelAdapter;
  private config: ChannelConfig;
  private secret: string | undefined;
  /** Request slots (one per in-flight chat) and admission slots (one per delegated task, held for its whole run); separate so a task never starves its own requests. */
  private readonly requests: Semaphore;
  private readonly admissions: Semaphore;
  private rules: RuleId[] = [];
  private failures = 0;
  private backoffUntil = 0;
  unhealthy = false;
  /** Adapter-probed effort support (cleared on config reload); consulted when the caps carry no explicit value. */
  private effortProbed: boolean | undefined;

  constructor(adapter: ChannelAdapter, cfg: ChannelConfig, secret?: string) {
    this.adapter = adapter;
    this.config = cfg;
    this.secret = secret;
    this.requests = new Semaphore(cfg.maxParallel);
    this.admissions = new Semaphore(cfg.maxParallel);
  }

  get cfg(): ChannelConfig {
    return this.config;
  }

  /** Applies a reloaded config in place, keeping in-flight and queued work counted against the (possibly new) limit. */
  update(cfg: ChannelConfig): void {
    this.config = cfg;
    this.effortProbed = undefined;
    this.requests.setLimit(cfg.maxParallel);
    this.admissions.setLimit(cfg.maxParallel);
  }

  /** Business-policy rules ticked for this channel (effective: channel override else global). */
  setRules(rules: RuleId[]): void {
    this.rules = rules;
  }

  get policyRules(): readonly RuleId[] {
    return this.rules;
  }

  /**
   * Applies the business-policy rules to outgoing messages: tool results with a hit are replaced in the returned copy
   * (reported to `onWithheld`); a hit in any other message throws BusinessPolicyError and nothing is sent.
   */
  screen(messages: ChatMessage[], onWithheld?: (w: Violation[]) => void): ChatMessage[] {
    const out = applyOutbound(messages, this.rules);
    if (out.blocked.length) throw new BusinessPolicyError(this.cfg.id, out.blocked);
    if (out.withheld.length) onWithheld?.(out.withheld);
    return out.messages;
  }

  /** Waits for a task slot on this channel (limit = maxParallel); the returned function releases it. */
  async admit(): Promise<() => void> {
    await this.admissions.acquire();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.admissions.release();
    };
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
    await this.requests.acquire();
  }

  private release(): void {
    this.requests.release();
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    req = { ...req, messages: this.screen(req.messages, req.onWithheld) }; // before acquire: a blocked request holds no slot and is not a channel failure
    await this.acquire();
    const vision = capsFor(this.cfg, req.model).vision;
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

  /** Whether the channel's engine can set reasoning effort on this model: explicit caps win, else the run-time adapter probe; false when unproven. */
  effortSupport(model: string): boolean {
    return capsFor(this.cfg, model).effortSupport ?? this.effortProbed ?? false;
  }

  /** Resolves the adapter's effort probe (memoized by the adapter) so a later `effortSupport` is accurate without a prior wizard probe. Never throws. */
  async resolveEffortSupport(model: string): Promise<boolean> {
    if (capsFor(this.cfg, model).effortSupport === undefined && this.effortProbed === undefined && this.adapter.effortSupport) {
      try {
        this.effortProbed = await this.adapter.effortSupport(this.cfg);
      } catch {
        this.effortProbed = undefined;
      }
    }
    return this.effortSupport(model);
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

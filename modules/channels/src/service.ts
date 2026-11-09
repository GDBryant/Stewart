import type { ModelCaps } from "@stewart/models";
import type { ChannelConfig } from "./types.js";
import { ChannelRegistry, ManagedChannel } from "./registry.js";

export type ChannelHealth = "healthy" | "unhealthy" | "backoff" | "missing";

export interface ChannelServiceDeps {
  registry: ChannelRegistry;
  adapterDeps: unknown;
}

/** Config row as loaded (`maxParallel` optional; the service applies the per-type default). */
export type ChannelSpec = {
  id: string;
  type: string;
  enabled: boolean;
  baseUrl?: string;
  secretRef?: string;
  extraModels?: string[];
  maxParallel?: number;
  modelCaps?: Record<string, Partial<ModelCaps>>;
  [k: string]: unknown;
};

async function loadChannelSecret(
  c: ChannelSpec,
  host: { secrets: { get(ref: string): Promise<string | undefined> } },
  mc: ManagedChannel,
): Promise<{ ref: string; secret: string } | undefined> {
  if (!c.secretRef) return undefined;
  const secret = await host.secrets.get(c.secretRef);
  if (secret === undefined) return undefined;
  mc.setSecret(secret);
  return { ref: c.secretRef, secret };
}

/** The one channel surface other modules see: builds ManagedChannels from config, looks them up, reports breaker health, applies secrets. */
export class ChannelService {
  private managed = new Map<string, ManagedChannel>();

  constructor(private readonly deps: ChannelServiceDeps) {}

  /** Rebuild from config: disabled rows skipped, unknown types logged and skipped (never throws). Returns the secrets it read, by ref. */
  async rebuild(channels: ChannelSpec[], host: { secrets: { get(ref: string): Promise<string | undefined> }; log(msg: string): void }): Promise<Map<string, string>> {
    this.managed.clear();
    const secrets = new Map<string, string>();
    for (const c of channels) {
      if (!c.enabled) continue;
      try {
        const adapter = this.deps.registry.create(c.type, this.deps.adapterDeps);
        const maxParallel = c.maxParallel ?? (c.type === "ollama" ? 1 : 4);
        const mc = new ManagedChannel(adapter, { ...c, maxParallel });
        const s = await loadChannelSecret(c, host, mc);
        if (s) secrets.set(s.ref, s.secret);
        this.managed.set(c.id, mc);
      } catch (e) {
        host.log(`channel ${c.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return secrets;
  }

  get(id: string): ManagedChannel | undefined {
    return this.managed.get(id);
  }

  /** Throws `channel ${id} not configured`. */
  require(id: string): ManagedChannel {
    const ch = this.managed.get(id);
    if (!ch) throw new Error(`channel ${id} not configured`);
    return ch;
  }

  ids(): string[] {
    return [...this.managed.keys()];
  }

  health(id: string): ChannelHealth {
    return this.managed.get(id)?.health ?? "missing";
  }

  listModels(id: string): Promise<string[]> {
    return this.require(id).listModels();
  }

  probe(id: string, model: string): Promise<Partial<ModelCaps>> {
    return this.require(id).probeCaps(model);
  }

  /** Applies a secret to every channel whose cfg.secretRef matches; returns how many were updated. */
  setSecret(ref: string, value: string | undefined): number {
    let n = 0;
    for (const mc of this.managed.values()) {
      if (mc.cfg.secretRef === ref) {
        mc.setSecret(value);
        n++;
      }
    }
    return n;
  }
}

import { useState } from "preact/hooks";
import type { Store } from "./state.js";
import type { AgentSummary, ChannelSummary } from "./bridge.js";
import { agentCosts } from "./bridge.js";

/** An agent is unmetered when its billing says so, or when an openai-compatible channel (other than aif) has no billing set. */
export function isUnmeteredAgent(item: AgentSummary, ch: ChannelSummary | undefined): boolean {
  return item.billing === "unmetered" || (!item.billing && ch?.type === "openai-compatible" && ch.id !== "aif");
}

function CapBadges({ caps }: { caps: Record<string, unknown> }) {
  return (
    <>
      {typeof caps.tools === "string" ? <span class="badge">tools:{caps.tools}</span> : null}
      {caps.vision ? <span class="badge">vision</span> : null}
      {caps.reasoning ? <span class="badge">reasoning</span> : null}
      {caps.imageGen ? <span class="badge">imageGen</span> : null}
      {typeof caps.contextTokens === "number" ? <span class="badge">{Math.round(caps.contextTokens / 1000)}k</span> : null}
    </>
  );
}

function AgentBadges({ item, ch, channels, caps }: { item: AgentSummary; ch: ChannelSummary | undefined; channels: ChannelSummary[]; caps: Record<string, unknown> }) {
  return (
    <>
      {agentCosts(item, channels) ? <span class="badge warn" title="This agent incurs cost">$ costs</span> : null}
      {isUnmeteredAgent(item, ch) ? <span class="badge warn" title="Spend is not visible to cost limit">unmetered</span> : null}
      <CapBadges caps={caps} />
    </>
  );
}

function QualStatus({ qual }: { qual: { agent?: { passed: boolean; detail?: string }; function?: { passed: boolean; detail?: string }; error?: string } | undefined }) {
  if (!qual) return null;
  if (qual.error) return <span class="fail">✗ {qual.error}</span>;
  const a = qual.agent?.passed;
  const f = qual.function?.passed;
  const d = qual.agent?.detail ?? qual.function?.detail;
  return <span class={a === false && f === false ? "fail" : "ok"} title={d}>qual:{a === undefined ? "" : a ? "A✓" : "A✗"}{f === undefined ? "" : f ? " F✓" : " F✗"}</span>;
}

function ProbeStatus({ probe, waiting }: { probe: { ok: boolean; error?: string; cached?: boolean; probedAt?: number } | undefined; waiting: boolean }) {
  if (waiting) return <span class="hint">probing…</span>;
  if (!probe) return null;
  return probe.ok
    ? <span class="ok" title={probe.probedAt ? new Date(probe.probedAt).toLocaleString() : undefined}>✓ probed{probe.cached ? " (cached)" : ""}</span>
    : <span class="fail">✗ {probe.error ?? "probe failed"}</span>;
}

export function AgentExtra({ item, channels, store }: { item: AgentSummary; channels: ChannelSummary[]; store: Store }) {
  const ch = channels.find((c) => c.id === item.channel);
  const probe = store.state.probeResults[`${item.channel}:${item.model}`];
  const staticCaps = (ch?.modelCaps?.[item.model] ?? {}) as Record<string, unknown>;
  const caps = { ...staticCaps, ...(probe?.caps ?? {}) };
  const qualStored = (ch?.modelCaps?.[item.model] as Record<string, unknown> | undefined)?.qualified as { agent?: { passed: boolean }; function?: { passed: boolean } } | undefined;
  const qual = store.state.qualResults[`${item.channel}:${item.model}`] ?? qualStored;
  const [pending, setPending] = useState<{ prev: unknown } | null>(null);
  const waiting = pending !== null && pending.prev === probe;
  return (
    <span class="extra">
      <AgentBadges item={item} ch={ch} channels={channels} caps={caps} />
      <ProbeStatus probe={probe} waiting={waiting} />
      <QualStatus qual={qual} />
      <button class="small" onClick={() => { store.qualifyModel(item.channel, item.model); store.requestConfig(); }}>Qualify</button>
      <button class="small" disabled={waiting} onClick={() => { setPending({ prev: probe }); store.probeModel(item.channel, item.model, true); }}>
        {probe ? "Re-probe" : "Probe"}
      </button>
    </span>
  );
}

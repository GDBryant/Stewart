import { useEffect, useRef, useState } from "preact/hooks";
import type { State, Store } from "./state.js";
import type { AgentSummary, ChannelSummary } from "./bridge.js";
import { PRESETS, channelModels, key, type WizardPriorities } from "./wizardShared.js";

export interface WizardDerivedInput {
  store: Store;
  channels: ChannelSummary[];
  agents: AgentSummary[];
  source: "existing" | "new";
  added: Set<string>;
  evalChannel: string;
  evaluator: string;
}

function getEvaluatorOptions(input: {
  store: Store;
  evalChanObj: ChannelSummary | undefined;
  evalChan: string;
  evalAgents: AgentSummary[];
  source: "existing" | "new";
}): { v: string; label: string }[] {
  const { store, evalChanObj, evalChan, evalAgents, source } = input;
  if (!evalChanObj) return [];
  if (source === "existing" && evalAgents.length) return evalAgents.map((a) => ({ v: key(evalChan, a.model), label: `${a.id} (${a.model})` }));
  return channelModels(store, evalChanObj).map((m) => ({ v: key(evalChan, m), label: m }));
}

/** Keeps the chosen channel when it is still offered, otherwise falls back to the first one ("" when none). */
export function resolveEvalChannel(evalChannels: ChannelSummary[], evalChannel: string): string {
  return evalChannels.some((c) => c.id === evalChannel) ? evalChannel : (evalChannels[0]?.id ?? "");
}

/** Keeps the chosen evaluator when it is still offered, otherwise falls back to the first option ("" when none). */
export function resolveEvaluator(options: { v: string }[], evaluator: string): string {
  return options.some((o) => o.v === evaluator) ? evaluator : (options[0]?.v ?? "");
}

/** Smoke-probe view of the candidate pairs: only green pairs are eligible once a run has happened. */
export function smokeState(smoke: State["smoke"], pairs: { channel: string; model: string }[]) {
  const smokeRan = !!smoke && smoke.status !== "idle";
  const greenKeys = new Set((smoke?.green ?? []).map((g) => key(g.channel, g.model)));
  const eligiblePairs = smokeRan ? pairs.filter((p) => greenKeys.has(key(p.channel, p.model))) : pairs;
  const probeBusy = !smokeRan || smoke.status === "running";
  const retryable = !!smoke?.items.some((i) => i.state === "orange" || i.state === "red" || i.state === "skipped");
  return { eligiblePairs, probeBusy, retryable };
}

export function useWizardDerived(input: WizardDerivedInput) {
  const { store, channels, agents, source, added, evalChannel, evaluator } = input;
  const tests = store.state.channelTest;
  const enabled = channels.filter((c) => c.enabled);
  const okChannels = enabled.filter((c) => tests[c.id]?.ok);
  const pairs = okChannels.flatMap((c) => channelModels(store, c).map((m) => ({ channel: c.id, model: m })));
  const { eligiblePairs, probeBusy, retryable } = smokeState(store.state.smoke, pairs);
  const evalChannels = source === "existing" ? okChannels : okChannels.filter((c) => added.has(c.id));
  const evalChan = resolveEvalChannel(evalChannels, evalChannel);
  const evalChanObj = evalChannels.find((c) => c.id === evalChan);
  const evalAgents = evalChan ? agents.filter((a) => a.channel === evalChan) : [];
  const evalOptions = getEvaluatorOptions({ store, evalChanObj, evalChan, evalAgents, source });
  const evalSel = resolveEvaluator(evalOptions, evaluator);
  const probeSig = pairs.map((p) => key(p.channel, p.model)).sort().join("|");

  return { tests, enabled, okChannels, pairs, smoke: store.state.smoke, eligiblePairs, probeBusy, retryable, evalChannels, evalChan, evalChanObj, evalAgents, evalOptions, evalSel, probeSig };
}
export function useWizardChannelForm(input: { store: Store; channels: ChannelSummary[] }) {
  const { store, channels } = input;
  const [preset, setPreset] = useState(PRESETS[0]);
  const [chId, setChId] = useState(PRESETS[0].id);
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [added, setAdded] = useState<Set<string>>(new Set());
  const pickPreset = (label: string) => {
    const p = PRESETS.find((x) => x.label === label) ?? PRESETS[0];
    setPreset(p);
    setChId(channels.some((c) => c.id === p.id) ? `${p.id}-2` : p.id);
    setBaseUrl(p.baseUrl);
    setApiKey("");
  };
  const addChannel = () => {
    if (!chId.trim()) return;
    // The setup session writes channels.yaml and puts the key in the IDE secret store (never in YAML).
    store.addSetupChannel({ id: chId.trim(), type: preset.type, enabled: true, ...(baseUrl ? { baseUrl } : {}) }, apiKey || undefined);
    setApiKey("");
    setAdded((prev) => new Set(prev).add(chId));
    pickPreset(preset.label);
  };
  return { preset, chId, setChId, baseUrl, setBaseUrl, apiKey, setApiKey, added, pickPreset, addChannel };
}

export function useWizardPreferences(store: Store) {
  const [priorities, setPriorities] = useState<WizardPriorities>(() => {
    const p = store.state.config?.summary.settings?.setupPriorities;
    return { speed: p?.speed ?? 2, cost: p?.cost ?? 2, quality: p?.quality ?? 2 };
  });
  const [typicalWork, setTypicalWork] = useState(store.state.config?.summary.settings?.setupTypicalWork ?? "");
  return { priorities, setPriorities, typicalWork, setTypicalWork };
}

export function useWizardProbes(input: {
  store: Store;
  step: number;
  enabled: ChannelSummary[];
  tests: State["channelTest"];
  probeSig: string;
  pairs: { channel: string; model: string }[];
  evalSel: string;
}) {
  const { store, step, enabled, tests, probeSig, pairs, evalSel } = input;
  // Test every configured channel once it appears (config.set rebuilds the live channels first).
  useEffect(() => {
    if (step !== 1) return;
    for (const c of enabled) if (!tests[c.id]) store.testChannel(c.id);
  }, [step, enabled.map((c) => c.id).join()]);

  // Discover: start the server-owned smoke queue once per candidate set; the same
  // signature returns the cached snapshot, so re-renders/back-navigation never re-probe.
  const probeSent = useRef("");
  useEffect(() => {
    if (step !== 2 || !probeSig || probeSent.current === probeSig) return;
    probeSent.current = probeSig;
    const i = evalSel.indexOf(":");
    const ev = evalSel && i > 0 ? { channel: evalSel.slice(0, i), model: evalSel.slice(i + 1) } : undefined;
    store.startProbe(pairs.map((p) => ({ channel: p.channel, model: p.model })), ev);
  }, [step, probeSig, evalSel]);
}

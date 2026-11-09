import type { State, Store } from "./state.js";
import type { ChannelSummary } from "./bridge.js";

export type Preset = { label: string; id: string; type: string; baseUrl: string; needsKey: boolean; help: string };

export const PRESETS: Preset[] = [
  { label: "Ollama (local)", id: "local-ollama", type: "ollama", baseUrl: "http://localhost:11434", needsKey: false, help: "Free, runs on your machine. Install from ollama.com, then run `ollama pull <model>` (for example qwen3 or qwen2.5-coder)." },
  { label: "OpenAI", id: "openai", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsKey: true, help: "Paste an API key from platform.openai.com. Usage is billed by OpenAI." },
  { label: "OpenRouter", id: "openrouter", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, help: "One key, many hosted models. Create a key at openrouter.ai." },
  { label: "LM Studio (local)", id: "lmstudio", type: "openai-compatible", baseUrl: "http://localhost:1234/v1", needsKey: false, help: "Start the LM Studio local server first. A key is usually not needed." },
  { label: "Other OpenAI-compatible", id: "custom", type: "openai-compatible", baseUrl: "", needsKey: true, help: "Any server that speaks the OpenAI API. Enter its URL (ending in /v1) and key." },
  { label: "Claude CLI", id: "claude", type: "claude-cli", baseUrl: "", needsKey: false, help: "Uses the `claude` command already logged in on this machine. No key needed." },
];

export const STEPS = ["Welcome", "Channels", "Discover", "Evaluator", "Review", "Done"] as const;

export type WizardPriorities = { speed: number; cost: number; quality: number };

export const key = (c: string, m: string) => `${c}:${m}`;

export function channelModels(store: Store, c: ChannelSummary): string[] {
  const t = store.state.channelTest[c.id];
  return [...new Set([...(t?.ok ? t.models ?? [] : []), ...(c.extraModels ?? [])])];
}

export function capBadges(caps?: Record<string, unknown>): string {
  if (!caps) return "";
  const out: string[] = [];
  if (caps.tools) out.push(`tools:${caps.tools}`);
  if (caps.vision) out.push("vision");
  if (caps.reasoning) out.push("reasoning");
  if (caps.imageGen) out.push("image-gen");
  if (typeof caps.contextTokens === "number") out.push(`${Math.round(caps.contextTokens / 1000)}k ctx`);
  const perf = caps.perf as { ttftMs?: number; tokPerSec?: number; toolReliability?: number; jsonOk?: boolean; editOk?: boolean } | undefined;
  if (perf) {
    if (perf.tokPerSec !== undefined) out.push(`${Math.round(perf.tokPerSec)} tok/s`);
    if (perf.ttftMs !== undefined) out.push(`ttft ${(perf.ttftMs / 1000).toFixed(1)}s`);
    if (perf.toolReliability !== undefined) out.push(`tool ${Math.round(perf.toolReliability * 3)}/3`);
    if (perf.editOk !== undefined) out.push(perf.editOk ? "edit ok" : "edit fail");
    if (perf.jsonOk !== undefined) out.push(perf.jsonOk ? "json ok" : "json fail");
  }
  return out.join(" · ");
}

export function rowRef(rec: State["recommendation"], edits: Record<string, string>, role: string): string {
  const a = rec?.assignments.find((x) => x.role === role);
  return edits[role] ?? (a ? key(a.channel, a.model) : "");
}

export function recommendArgs(input: {
  evalMode: "rules" | "ai";
  evaluator: string;
  evalSel: string;
  eligiblePairs: { channel: string; model: string }[];
  priorities: WizardPriorities;
  typicalWork: string;
  bench: boolean;
}): Parameters<Store["recommend"]>[0] {
  const f = input.evaluator || input.evalSel || (input.eligiblePairs[0] ? key(input.eligiblePairs[0].channel, input.eligiblePairs[0].model) : "");
  const i = f.indexOf(":");
  const ev = input.evalMode === "ai" && f ? { evaluator: { channel: f.slice(0, i), model: f.slice(i + 1) } } : {};
  return { mode: input.evalMode, ...ev, context: { priorities: input.priorities, ...(input.typicalWork ? { typicalWork: input.typicalWork } : {}) }, bench: input.bench };
}

/** Maps raw channel-test errors to something a new user can act on. */
export function friendlyError(type: string, err?: string): string {
  const e = err ?? "";
  if (/401|403|unauthor|invalid.*key/i.test(e)) return "The server rejected the API key. Check it and try again.";
  if (/ECONNREFUSED|fetch failed|connect|ENOTFOUND/i.test(e)) return type === "ollama" ? "Cannot reach Ollama. Is it installed and running (`ollama serve`)?" : "Cannot reach the server. Check the URL and that it is running.";
  if (/404/.test(e)) return "Server answered but the path was not found. Check the base URL (OpenAI-compatible URLs usually end in /v1).";
  return e || "Connection failed.";
}

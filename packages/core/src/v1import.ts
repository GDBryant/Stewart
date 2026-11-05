import { stringify as stringifyYaml } from "yaml";
import { normalizeModel } from "./channels/claude/transcript.js";

/** v1 `stewart.xml` fields mapped onto v2 config. One-shot, no ongoing compat. */
export interface V1ImportResult {
  files: Record<string, string>;
  warnings: string[];
}

/** Minimal XML surface so core stays DOM-free; hosts inject a real parser or the test shim. */
export interface XmlNode {
  getAttribute(name: string): string | null;
  querySelector(sel: string): XmlNode | null;
  querySelectorAll(sel: string): XmlNode[];
}

function opt(doc: XmlNode, name: string): string | undefined {
  const el = [...doc.querySelectorAll("option")].find((o) => o.getAttribute("name") === name);
  return el?.getAttribute("value") ?? undefined;
}

function listOpt(doc: XmlNode, name: string): string[] {
  const el = [...doc.querySelectorAll("option")].find((o) => o.getAttribute("name") === name);
  if (!el) return [];
  return [...el.querySelectorAll("option")].map((o) => o.getAttribute("value") ?? "").filter(Boolean);
}

function mapOpt(doc: XmlNode, name: string): Record<string, string> {
  const el = [...doc.querySelectorAll("option")].find((o) => o.getAttribute("name") === name);
  if (!el) return {};
  const out: Record<string, string> = {};
  for (const e of el.querySelectorAll("entry")) {
    const k = e.getAttribute("key");
    const v = e.getAttribute("value");
    if (k && v) out[k] = v;
  }
  return out;
}

/** Tiny XML tree for flat IntelliJ option files (option/list/map, no namespaces). */
class MiniXml implements XmlNode {
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string>,
    readonly children: MiniXml[],
  ) {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  private matches(sel: string): boolean {
    const m = /^([a-zA-Z0-9]+)(?:\[name="([^"]+)"\])?$/.exec(sel.trim());
    if (!m || m[1] !== this.tag) return false;
    return m[2] === undefined || this.attrs.name === m[2];
  }
  querySelector(sel: string): XmlNode | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): XmlNode[] {
    const out: XmlNode[] = [];
    const walk = (n: MiniXml) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

/** Lenient parser for `<tag attr="v">` shapes; ignores text content. Throws on mismatched tags. */
export function parseMiniXml(xml: string): XmlNode {
  const root = new MiniXml("__root__", {}, []);
  const stack = [root];
  const re = /<([a-zA-Z0-9_-]+)((?:\s+[a-zA-Z0-9_-]+="[^"]*")*)\s*(\/?)>|<\/([a-zA-Z0-9_-]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[4]) {
      const top = stack.pop();
      if (!top || top.tag !== m[4] || stack.length === 0) throw new Error(`mismatched </${m[4]}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const am of (m[2] ?? "").matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
      attrs[am[1]] = am[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    const node = new MiniXml(m[1], attrs, []);
    stack[stack.length - 1].children.push(node);
    if (m[3] !== "/") stack.push(node);
  }
  if (stack.length !== 1) throw new Error("unclosed XML tag");
  return root;
}

/** Parse v1 `<ref>provider/model</ref>` strings like `ollama/llama3`, `aif/gpt-4o`, `claude/sonnet`. */
function modelRef(raw: string | undefined): { provider: string; model: string } | undefined {
  if (!raw) return undefined;
  const i = raw.indexOf("/");
  if (i < 0) return undefined;
  return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
}

export function importV1Xml(xml: string, parseDom: (s: string) => XmlNode): V1ImportResult {
  const warnings: string[] = [];
  let doc: XmlNode;
  try {
    doc = parseDom(xml);
  } catch (e) {
    return { files: {}, warnings: [`could not parse stewart.xml: ${e instanceof Error ? e.message : e}`] };
  }
  const component = doc.querySelector('component[name="StewartSettings"]');
  if (!component) return { files: {}, warnings: ["no StewartSettings component found — not a v1 settings file"] };

  const channels: Record<string, unknown>[] = [];
  const agents: Record<string, unknown>[] = [];
  const roles: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  const ollamaUrl = opt(component, "ollamaUrl") || "http://localhost:11434";
  channels.push({ id: "ollama", type: "ollama", enabled: true, baseUrl: ollamaUrl });

  const aifBase = opt(component, "aifBaseUrl");
  const aifModels = listOpt(component, "aifModels");
  if (aifBase) {
    channels.push({ id: "aif", type: "openai-compatible", enabled: true, baseUrl: aifBase, extraModels: aifModels });
  }

  const claudePath = opt(component, "claudeCliPath") || "claude";
  const claudeModels = listOpt(component, "claudeModels").map(normalizeModel);
  channels.push({ id: "claude", type: "claude-cli", enabled: true, cliPath: claudePath, extraModels: claudeModels });

  const channelFor = (provider: string): string | undefined => {
    if (provider === "ollama") return "ollama";
    if (provider === "claude") return "claude";
    if (provider === "aif") return aifBase ? "aif" : undefined;
    warnings.push(`unknown v1 provider '${provider}' — skipped`);
    return undefined;
  };

  const effort = opt(component, "effort")?.toLowerCase();
  const mkAgent = (id: string, ref: { provider: string; model: string } | undefined) => {
    if (!ref || seen.has(id)) return;
    const channel = channelFor(ref.provider);
    if (!channel) return;
    seen.add(id);
    agents.push({ id, channel, model: ref.model, ...(effort ? { effort } : {}) });
  };

  const chat = modelRef(opt(component, "chatModel"));
  mkAgent("chat", chat);
  const roleMap: [string, string, string][] = [
    ["plannerModel", "planner", "planner"],
    ["executorModel", "executor", "code-writer"],
    ["workerModel", "worker", "general-worker"],
  ];
  for (const [optName, agentId, roleId] of roleMap) {
    const ref = modelRef(opt(component, optName));
    mkAgent(agentId, ref);
    if (ref && seen.has(agentId)) roles.push({ id: roleId, enabled: true, agent: agentId });
  }
  if (chat && !roles.length && seen.has("chat")) {
    roles.push({ id: "general-worker", enabled: true, agent: "chat" });
  }

  const numCtx = mapOpt(component, "ollamaNumCtx");
  const ollama = channels.find((c) => c.id === "ollama") as Record<string, unknown> | undefined;
  if (ollama && Object.keys(numCtx).length) {
    const caps: Record<string, { numCtx: number }> = {};
    for (const [k, v] of Object.entries(numCtx)) {
      const model = k.startsWith("ollama/") ? k.slice(7) : k;
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) caps[model] = { numCtx: n };
    }
    if (Object.keys(caps).length) ollama.modelCaps = caps;
  }

  const visionOverrides = listOpt(component, "visionModelOverrides");
  for (const ref of visionOverrides) {
    const r = modelRef(ref);
    const ch = r ? channels.find((c) => c.id === channelFor(r.provider)) as Record<string, unknown> | undefined : undefined;
    if (!r || !ch) continue;
    const caps = (ch.modelCaps ?? {}) as Record<string, Record<string, unknown>>;
    caps[r.model] = { ...(caps[r.model] ?? {}), vision: true };
    ch.modelCaps = caps;
  }

  const files: Record<string, string> = {
    "channels.yaml": stringifyYaml({ version: 1, items: channels }),
  };
  if (agents.length) files["agents.yaml"] = stringifyYaml({ version: 1, items: agents });
  if (roles.length) files["roles.yaml"] = stringifyYaml({ version: 1, items: roles });

  const retentionRaw = opt(component, "historyRetentionDays");
  const retention = retentionRaw === undefined ? NaN : Number(retentionRaw);
  const settings: Record<string, unknown> = { version: 1 };
  if (Number.isInteger(retention) && retention >= 0) settings.historyRetentionDays = retention;
  if (opt(component, "debugLogEnabled") === "true") {
    settings.log = { level: "calls", retainDays: Number(opt(component, "debugLogRetentionDays") ?? 7) || 7 };
  }
  if (Object.keys(settings).length > 1) files["settings.yaml"] = stringifyYaml(settings);

  if (!agents.length) warnings.push("no v1 models found — imported channels only");
  const skipped = ["autoApproveEdits", "multiModel", "autoCompactTokens", "toolPathOverrides", "toolsEnabled"]
    .filter((k) => opt(component, k) !== undefined);
  if (skipped.length) warnings.push(`v1-only settings not imported: ${skipped.join(", ")}`);
  return { files, warnings };
}

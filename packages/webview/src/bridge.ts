/** Host messaging seam. VS Code injects acquireVsCodeApi; JCEF injects
 * window.stewartHost { post(string) }; tests pass a MockBridge. */
export type Outbound =
  | { type: "chat.send"; text: string; images?: string[]; sessionId?: string }
  | { type: "chat.cancel"; runId: string }
  | { type: "chat.answer"; questionId: string; answer: string }
  | { type: "chat.approve"; approvalId: string; grant: "once" | "chat" | "always" | "deny" }
  | { type: "config.get" }
  | { type: "config.set"; file: string; yaml: string; layer?: "user" | "project" }
  | { type: "history.list" }
  | { type: "history.load"; sessionId: string }
  | { type: "history.delete"; sessionId: string }
  | { type: "channel.test"; channelId: string }
  | { type: "channel.probe"; channelId: string; model: string; force?: boolean; bench?: boolean }
  | { type: "secret.set"; ref: string; value: string }
  | { type: "secret.delete"; ref: string }
  | { type: "skills.save"; id: string; body: string; description?: string }
  | { type: "skills.reset"; id: string }
  | { type: "skills.open"; id: string }
  | { type: "roles.reset"; roleId?: string }
  | { type: "roles.assignAgent"; agentId: string; wizard?: boolean }
  | { type: "setup.recommend"; mode?: "rules" | "ai"; evaluator?: { channel: string; model: string }; evaluatorAny?: boolean; context?: { priorities?: { speed?: number; cost?: number; quality?: number }; typicalWork?: string }; bench?: boolean }
  | { type: "setup.probe.start"; candidates?: { channel: string; model: string }[]; evaluator?: { channel: string; model: string } }
  | { type: "setup.qualify"; channel: string; model: string }
  | { type: "setup.probe.status" }
  | { type: "setup.probe.cancel" }
  | { type: "setup.probe.retry" }
  | { type: "setup.session.start" }
  | { type: "setup.session.update"; patch: Record<string, unknown> }
  | { type: "setup.session.advance" }
  | { type: "setup.session.back" }
  | { type: "setup.session.cancel" }
  | { type: "setup.session.addChannel"; channel: { id: string; type: string; baseUrl?: string; enabled?: boolean }; apiKey?: string }
  | { type: "setup.session.removeChannel"; id: string }
  | { type: "setup.review" }
  | { type: "setup.approve"; token: string }
  | { type: "setup.undo" }
  | { type: "ready" };

export interface ChannelSummary {
  id: string; type: string; name?: string; enabled: boolean; baseUrl?: string; secretRef?: string;
  extraModels?: string[]; maxParallel?: number; modelCaps?: Record<string, unknown>;
}
export interface AgentSummary {
  id: string; channel: string; model: string; effort?: string; temperature?: number; billing?: string; costs?: boolean;
  price?: { inPerMTok: number; outPerMTok: number };
}
export interface RoleSummary {
  id: string; enabled: boolean; agent?: string; chain?: string[]; skills?: string[];
  kind?: "agent" | "function"; needs?: { vision?: boolean; minContext?: number };
  tools?: string[]; writePaths?: string[]; turnBudget?: number | string; prompt?: string;
}
export interface SkillSummary {
  id: string; description: string; body: string; version: number;
  source: "shipped" | "user" | "project"; edited: boolean; updateAvailable: boolean;
}
export interface SettingsSummary {
  costLimit?: { perRunUsd?: number; onLimit?: string };
  skillBudgetTokens?: number;
  setupPriorities?: { speed?: number; cost?: number; quality?: number };
  setupTypicalWork?: string;
  log?: { level?: string; retainDays?: number };
}
export interface ConfigSummary {
  channels: ChannelSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  skills: SkillSummary[];
  settings: SettingsSummary;
}

export interface ConfigReply {
  files: Record<string, string | undefined>;
  summary: ConfigSummary;
  errors: string[];
  /** secretRef -> whether a value is stored (never the value itself). */
  secrets?: Record<string, boolean>;
}

/** Pricing/limits info attached to probe results; `source` is "live" or "catalog <date>". */
export interface CatalogInfo {
  inPerMTok?: number;
  outPerMTok?: number;
  contextTokens?: number;
  rpm?: number;
  tpm?: number;
  family?: string;
  tier?: string;
  source: string;
}

export type SetupProbeState = "queued" | "running" | "green" | "orange" | "red" | "skipped";
export interface SetupProbeItem {
  channel: string;
  model: string;
  state: SetupProbeState;
  reason?: string;
  lastReason?: string;
  attempts?: number;
  waitMs?: number;
  durationMs?: number;
  qualified?: { agent?: boolean; function?: boolean; detail?: string };
}
export type SetupProbeCounts = Record<SetupProbeState, number>;
export interface SetupProbeSnapshot {
  status: "idle" | "running" | "done" | "cancelled";
  runId: number;
  ranking: boolean;
  items: SetupProbeItem[];
  counts: SetupProbeCounts;
  green: { channel: string; model: string }[];
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  savedAt: number;
  messageCount: number;
}

export interface StoredMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  images?: string[];
}

export type Inbound =
  | { type: "event"; ev: import("@stewart/protocol").RunEvent }
  | ({ type: "config" } & ConfigReply)
  | { type: "channel.test.result"; channelId: string; ok: boolean; models?: string[]; error?: string }
  | { type: "channel.probe.result"; channelId: string; model: string; ok: boolean; caps?: Record<string, unknown>; probedAt?: number; cached?: boolean; catalog?: CatalogInfo; error?: string }
  | { type: "history.sessions"; sessions: SessionSummary[] }
  | { type: "history.messages"; sessionId: string; messages: StoredMessage[] }
  | { type: "insertText"; text: string }
  | { type: "ready" }
  | {
      type: "setup.recommend.result";
      ok: boolean;
      assignments?: { role: string; channel: string; model: string; chain?: { channel: string; model: string }[]; reason?: string; score?: number; warnings?: string[]; source?: "rules" | "ai" }[];
      researcher?: { channel: string; model: string };
      unfilled?: { role: string; reason: string }[];
      dropped?: string[];
      error?: string;
    }
  | ({ type: "setup.probe.result" } & SetupProbeSnapshot)
  | { type: "setup.session.result"; phase?: string; draft?: Record<string, unknown>; ok?: boolean; error?: string }
  | { type: "setup.session.addChannel.result"; ok: boolean; error?: string }
  | { type: "setup.session.removeChannel.result"; ok: boolean; error?: string }
  | { type: "setup.review.result"; token?: string; error?: string }
  | { type: "setup.approve.result"; ok: boolean; error?: string }
  | { type: "setup.undo.result"; ok: boolean; error?: string }
  | { type: "setup.qualify.result"; channel: string; model: string; agent?: { passed: boolean; detail?: string }; function?: { passed: boolean; detail?: string }; error?: string }
  | { type: "error"; message: string };

export interface Bridge {
  post(msg: Outbound): void;
  onMessage(fn: (msg: Inbound) => void): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(m: unknown): void };
    stewartHost?: { post(json: string): void };
    __stewartInbound?: (msg: Inbound) => void;
  }
}

export function detectBridge(): Bridge {
  if (typeof window !== "undefined" && window.acquireVsCodeApi) {
    const api = window.acquireVsCodeApi();
    return {
      post: (m) => api.postMessage(m),
      onMessage: (fn) => window.addEventListener("message", (e) => fn(e.data as Inbound)),
    };
  }
  if (typeof window !== "undefined" && window.stewartHost) {
    const host = window.stewartHost;
    return {
      post: (m) => host.post(JSON.stringify(m)),
      onMessage: (fn) => {
        window.__stewartInbound = fn;
      },
    };
  }
  return { post: () => {}, onMessage: () => {} };
}

export class MockBridge implements Bridge {
  sent: Outbound[] = [];
  private listeners: ((m: Inbound) => void)[] = [];
  post(msg: Outbound): void {
    this.sent.push(msg);
  }
  onMessage(fn: (m: Inbound) => void): void {
    this.listeners.push(fn);
  }
  inbound(msg: Inbound): void {
    for (const l of this.listeners) l(msg);
  }
}

/** Known-cost flag: explicit `costs` wins; else priced/reported billing, or a claude-cli channel by default. */
export function agentCosts(a: AgentSummary | undefined, channels: ChannelSummary[]): boolean {
  if (!a) return false;
  if (typeof a.costs === "boolean") return a.costs;
  if (a.billing) return a.billing === "priced" || a.billing === "reported";
  return channels.find((c) => c.id === a.channel)?.type === "claude-cli";
}

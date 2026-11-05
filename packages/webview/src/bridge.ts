/** Host messaging seam. VS Code injects acquireVsCodeApi; JCEF injects
 * window.stewartHost { post(string) }; tests pass a MockBridge. */
export type Outbound =
  | { type: "chat.send"; text: string; images?: string[]; direct?: boolean }
  | { type: "chat.cancel"; runId: string }
  | { type: "chat.resume"; runId: string }
  | { type: "chat.answer"; questionId: string; answer: string }
  | { type: "chat.approve"; approvalId: string; grant: "once" | "chat" | "always" | "deny" }
  | { type: "config.get" }
  | { type: "config.set"; file: string; yaml: string; layer?: "user" | "project" }
  | { type: "channel.test"; channelId: string }
  | { type: "secret.set"; ref: string; value: string }
  | { type: "secret.delete"; ref: string }
  | { type: "skills.save"; id: string; body: string; description?: string }
  | { type: "skills.reset"; id: string }
  | { type: "skills.open"; id: string }
  | { type: "roles.reset"; roleId?: string }
  | { type: "roles.assignAgent"; agentId: string }
  | { type: "ready" };

export interface ChannelSummary {
  id: string; type: string; name?: string; enabled: boolean; baseUrl?: string; secretRef?: string;
  extraModels?: string[]; maxParallel?: number; modelCaps?: Record<string, unknown>;
}
export interface AgentSummary {
  id: string; channel: string; model: string; effort?: string; temperature?: number; billing?: string;
  price?: { inPerMTok: number; outPerMTok: number };
}
export interface RoleSummary {
  id: string; enabled: boolean; agent?: string; fallbackAgent?: string; skills?: string[];
  tools?: string[]; writePaths?: string[]; turnBudget?: number | string; prompt?: string;
}
export interface SkillSummary {
  id: string; description: string; body: string; version: number;
  source: "shipped" | "user" | "project"; edited: boolean; updateAvailable: boolean;
}
export interface SettingsSummary {
  costLimit?: { perRunUsd?: number; onLimit?: string };
  maxRunHours?: number;
  leaseWaitSeconds?: number;
  maxNestedDispatches?: number;
  maxReplans?: number;
  skillBudgetTokens?: number;
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
}

export type Inbound =
  | { type: "event"; ev: import("@stewart/protocol").RunEvent }
  | ({ type: "config" } & ConfigReply)
  | { type: "channel.test.result"; channelId: string; ok: boolean; models?: string[]; error?: string }
  | { type: "ready" }
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

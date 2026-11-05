/** Host messaging seam. VS Code injects acquireVsCodeApi; JCEF injects
 * window.stewartHost { post(string), onEvent(fn) }; tests pass a MockBridge. */
export type Outbound =
  | { type: "chat.send"; text: string; images?: string[]; direct?: boolean }
  | { type: "chat.cancel"; runId: string }
  | { type: "chat.resume"; runId: string }
  | { type: "chat.answer"; questionId: string; answer: string }
  | { type: "chat.approve"; approvalId: string; grant: "once" | "chat" | "always" | "deny" }
  | { type: "config.get" }
  | { type: "config.set"; file: string; yaml: string }
  | { type: "channel.test"; channelId: string }
  | { type: "ready" };

export type Inbound =
  | { type: "event"; ev: import("@stewart/protocol").RunEvent }
  | { type: "config"; yaml: string }
  | { type: "channel.test.result"; channelId: string; ok: boolean; models?: string[]; error?: string }
  | { type: "ready" };

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
  // Standalone / tests: loopback queue drained by the test harness.
  return {
    post: () => {},
    onMessage: () => {},
  };
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

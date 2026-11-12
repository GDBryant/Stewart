import type { ConfigReply, SessionSummary, SetupProbeSnapshot } from "./bridge.js";

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning?: string;
  streaming?: boolean;
  images?: string[];
  /** Collapsed activity rows: tool calls, tasks, approvals. */
  activity: { kind: string; text: string }[];
}

export const MAX_PENDING_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PendingApproval {
  approvalId: string;
  runId: string;
  tool: string;
  args: unknown;
  category: string;
}

export interface PendingQuestion {
  questionId: string;
  runId: string;
  question: string;
  options?: string[];
}

export interface TaskRow {
  taskId: string;
  roleId: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
  summary?: string;
  agentId?: string;
  /** Epoch ms when the task last entered running; drives the active-task timer. */
  startedAt?: number;
}

export interface CostState {
  capUsd: number;
  accruedUsd: number;
  overshootUsd: number;
  byRole: Record<string, number>;
  byAgent: Record<string, { costUsd: number; inTokens: number; outTokens: number }>;
  parked: string[];
  freeFinished: string[];
  suggestions: { role: string; agent: string; reason: string }[];
}

export interface PlanMilestone {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
  checkpoint?: string;
}

export interface PlanState {
  goal?: string;
  active: boolean;
  milestones: PlanMilestone[];
}

export interface State {
  items: ChatItem[];
  tasks: TaskRow[];
  plan?: PlanState;
  cost?: CostState;
  busyRunId?: string;
  lastRunId?: string;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  config?: ConfigReply;
  channelTest: Record<string, { ok: boolean; models?: string[]; error?: string }>;
  probeResults: Record<string, { ok: boolean; caps?: Record<string, unknown>; probedAt?: number; cached?: boolean; catalog?: import("./bridge.js").CatalogInfo; error?: string }>;
  wizardOpen?: boolean;
  view: "chat" | "settings";
  sessionId?: string;
  sessions: SessionSummary[];
  historyOpen: boolean;
  pendingImages: string[];
  attachError?: string;
  /** Host pushed text into the composer (e.g. "Add selection to chat"). */
  composerInsert?: { text: string; seq: number };
  /** Last {type:"error"} message; shown in Settings since it may carry no chat context. */
  lastError?: string;
  recommendBusy?: boolean;
  /** Server-owned setup quick-probe queue snapshot (queued/running/green/orange/red/skipped). */
  smoke?: SetupProbeSnapshot;
  setupPhase?: string;
  setupSaved?: boolean;
  qualResults: Record<string, { agent?: { passed: boolean; detail?: string }; function?: { passed: boolean; detail?: string }; error?: string }>;
  setupError?: string;
  /** Why the last wizard add/remove-channel request failed; cleared when the next one starts. */
  setupChannelError?: string;
  recommendation?: {
    assignments: { role: string; channel: string; model: string; chain?: { channel: string; model: string }[]; reason?: string; score?: number; warnings?: string[]; source?: "rules" | "ai" }[];
    researcher?: { channel: string; model: string };
    unfilled?: { role: string; reason: string }[];
    dropped?: string[];
  };
  recommendError?: string;
}

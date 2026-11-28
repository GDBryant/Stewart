import type { SlashCommandInfo } from "@stewart/protocol";
import type { ConfigReply, SessionSummary, SetupProbeSnapshot } from "./bridge.js";

/** One collapsed step in an assistant turn: a tool call, a check, or an escalation. */
export interface ActivityEntry {
  kind: string;
  text?: string;
  /** Tool name when this entry is a tool call (drives the icon). */
  tool?: string;
  /** Tool category from tool.request, e.g. READ / SEARCH / WRITE. */
  category?: string;
}

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning?: string;
  streaming?: boolean;
  images?: string[];
  /** Collapsed step rows: tool calls, checks, escalations. */
  activity: ActivityEntry[];
  /** Run this segment belongs to (all segments of a run share it; id is `runId` or `runId:n`). */
  runId?: string;
  /** Answered ask_user exchange; rendered as a compact card. */
  qa?: { question: string; answer: string };
  /** Activity count at the last text append (detects steps added between turns). */
  stepsAtText?: number;
  /** Start offset of text written after the last step (final-output split point). */
  tailStart?: number;
  /** Files changed by this run; shown in the "Files changed" footer. */
  filesChanged?: string[];
  /** Change-tracker baseline id for this run's filesChanged (enables per-file diff). */
  filesBaseline?: string;
  /** Show a "Revert this turn" action (failed run with a turn baseline). */
  revertTurn?: boolean;
  /** Mid-run guidance sent while a run was active (steer accepted, or loaded from history). */
  guidance?: boolean;
  plan?: PlanState;
}

/** One client-held follow-up: not posted until it reaches the head and nothing is running. */
export interface OutboxItem {
  id: string;
  sessionId?: string;
  text: string;
  images?: string[];
  createdAt: number;
  status: "pending" | "sending" | "failed";
  error?: string;
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
  bypass: boolean;
  questions: PendingQuestion[];
  config?: ConfigReply;
  channelTest: Record<string, { ok: boolean; models?: string[]; error?: string; reasoning?: { suggest?: "reasoning_effort" | "enable_thinking" | "none"; control?: boolean } }>;
  /** models.refresh in flight; summary line after it finishes. */
  refreshBusy?: boolean;
  refreshSummary?: string;
  /** Session-only dismiss of the Settings config warnings; resets when the webview reloads. */
  warningsDismissed?: boolean;
  probeResults: Record<string, { ok: boolean; caps?: Record<string, unknown>; probedAt?: number; cached?: boolean; catalog?: import("./bridge.js").CatalogInfo; error?: string }>;
  wizardOpen?: boolean;
  view: "chat" | "settings";
  sessionId?: string;
  sessions: SessionSummary[];
  slashCommands: SlashCommandInfo[];
  historyOpen: boolean;
  pendingImages: string[];
  draft: string;
  attachError?: string;
  /** Client-held follow-up queue (panel memory only; lost on reload). */
  outbox: OutboxItem[];
  /** A dispatched outbox head returned a runId; held until its run.started arrives. */
  outboxSending?: boolean;
  /** A chat.steer request is in flight. */
  steerPending?: boolean;
  /** Inline composer warning for steer fallback/restore. */
  steerWarning?: string;
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
    assignments: { role: string; channel: string; model: string; secondary?: { channel: string; model: string }; reason?: string; score?: number; warnings?: string[]; source?: "rules" | "ai" }[];
    researcher?: { channel: string; model: string };
    unfilled?: { role: string; reason: string }[];
    dropped?: string[];
  };
  recommendError?: string;
}

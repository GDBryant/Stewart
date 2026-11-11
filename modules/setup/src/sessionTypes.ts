import type { HostPort } from "@stewart/kernel";

/** §10 five-phase setup session types: phases, the persisted draft, progress events and host deps. */
export type SetupPhase = "channels" | "evaluator" | "evaluate" | "assign" | "approve" | "saved" | "cancelled";
export const SETUP_FILES = ["channels.yaml", "agents.yaml", "roles.yaml", "settings.yaml"] as const;

export interface Evaluation {
  done: number;
  total: number;
  tally: { evaluated: number; unavailable: number; skipped: number };
  results: Record<string, unknown>;
  finished?: boolean;
  stale?: boolean;
}

export interface SetupDraft {
  version: number;
  createdAt: number;
  phase: SetupPhase;
  secretsCreated: string[];
  channels: { id: string; tested?: "ok" | "failed"; models?: string[] }[];
  reusedChannels: string[];
  evaluator?: { channel: string; model: string; checked?: boolean } | "rules";
  candidates?: string[];
  evaluation?: Evaluation;
  assignment?: unknown;
  assignmentValid?: boolean;
  files?: Record<string, string>;
  approvalToken?: string;
  baseHash?: string;
  /** Channel ids this session wrote to channels.yaml ahead of approval (cancel rolls them back; review includes the file). */
  addedChannels: string[];
  /** channels.yaml as it was before the first session write (`null` = the file did not exist); absent until a channel is added. */
  channelsBase?: string | null;
}

export type SetupEvent =
  | { kind: "progress"; done: number; total: number; running: { model: string; stage: string }[]; tally: Evaluation["tally"] }
  | { kind: "model"; model: string; state: "evaluated" | "unavailable" | "skipped"; result?: unknown; error?: string }
  | { kind: "rating"; state: "started" | "done" | "skipped" }
  | { kind: "usage"; inTokens: number; outTokens: number; costUsd?: number }
  | { kind: "phase"; phase: SetupPhase };

export interface SetupSessionDeps {
  files: Pick<HostPort["files"], "exists" | "read" | "list" | "writeAtomic" | "delete">;
  stateDir: string;
  readUserFiles(): Promise<Record<string, string | undefined>>;
  writeUserFile(name: string, yaml: string): Promise<void>;
  /** Validate the rendered file set before writing; return an error string or undefined. */
  validateFiles?(files: Record<string, string>): string | undefined;
  /** Ids of every channel in the merged config (shipped + user + project), so an added id cannot shadow one. */
  existingChannelIds?(): string[];
  /** Remove a user config file (rolling back a file the session created). */
  deleteUserFile?(name: string): Promise<void>;
  /** Store a secret in the host secret store and make channels see it. */
  setSecret?(ref: string, value: string): Promise<void>;
  deleteSecret?(ref: string): Promise<void>;
  onEvent?(ev: SetupEvent): void;
  now?(): number;
}

import type { HostPort } from "@stewart/kernel";

/** Stable machine code for one piece of check evidence. */
export type EvidenceCode =
  | "write_failed"
  | "file_present"
  | "file_missing"
  | "command_ok"
  | "command_failed"
  | "command_unavailable"
  | "command_timeout"
  | "command_cancelled"
  | "command_denied"
  | "cited"
  | "citation_missing"
  | "citation_bad_line"
  | "no_read"
  | "no_change"
  | "policy_violation"
  | "empty_reply"
  | "health_ok"
  | "health_invalid";

/** One check fact: `ok` decides the result; `detail` is the human text. */
export interface Evidence {
  code: EvidenceCode;
  ok: boolean;
  detail: string;
}

/** A check code runs after a turn: files that must exist, and/or a command that must exit 0. */
export interface Check {
  /** Workspace-relative paths that must exist after the turn. */
  files?: string[];
  /** Argv commands run in order in the project root; each must exit 0 and the first failure stops the rest. */
  commands?: string[][];
  /** Every slash-path citation in the reply must exist and cited line numbers must be in range (bare names count only when they exist). */
  cites?: boolean;
  /** At least one successful read/search call this turn. */
  needsRead?: boolean;
  /** The reply must end with exactly one ```json block validating as a HealthReport. */
  schema?: "health";
  healthScope?: string[];
  /** At least one file must have changed since the baseline (skipped when tracking is unavailable). */
  mustChange?: boolean;
  /** Per-changed-path policy check: returns a deny reason or null. Skipped when tracking is unavailable. */
  pathRule?: (path: string) => string | null;
}

/** One write-tool call outcome, in call order. */
export interface WriteRecord {
  path: string;
  ok: boolean;
  message?: string;
}

export interface CheckInput {
  reply: string;
  writes: WriteRecord[];
  /** Paths the change tracker reports as differing from the turn baseline; undefined = tracking unavailable. */
  changed: string[] | undefined;
  /** Successful read/search tool calls this turn. */
  reads?: number;
}

export interface CheckResult {
  passed: boolean;
  evidence: Evidence[];
}

export interface RunCheckArgs {
  check: Check;
  input: CheckInput;
  host: Pick<HostPort, "files" | "proc">;
  cwd: string;
  timeoutMs?: number;
  /** When aborted, a running check command is killed instead of waiting out its timeout. */
  signal?: AbortSignal;
}

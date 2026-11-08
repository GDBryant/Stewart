import type { ToolSpec } from "@stewart/kernel";

export interface ProbeRequest {
  model: string;
  tool: ToolSpec;
  reply: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
}

export type ProbeResult = { kind: "ok"; toolOk: boolean } | { kind: "failed"; message: string };

/** Runs one tool-call probe through the real agent loop. C is the channel type (declared generically because channels sits above models). */
export type ProbeLoop<C = unknown> = (channel: C, req: ProbeRequest) => Promise<ProbeResult>;

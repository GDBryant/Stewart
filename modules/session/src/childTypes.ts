import type { AgentDef } from "@stewart/config";
import type { TaskDeps } from "./taskRun.js";
import type { RunState } from "./turnState.js";

/** Everything ChildRunner needs beyond the shared task-run deps. */
export interface ChildDeps extends TaskDeps {
  ids: { next(prefix: string): string };
  stateDir: string;
  runId: string;
  sessionId: string;
  /** The lead's first chain agent: fallback display/ledger agent for task.started. */
  agent: AgentDef | undefined;
  /** Shared counters with the parent turn: accrued cost, stream seq, cancel signal. */
  parent: RunState;
}

import type { Recovery, RunTaskOnce } from "@stewart/agent-loop";
import { SIZE_HINT, ensureRecovery, logRecovery } from "./consts.js";
import { recoveryBrain } from "./brain.js";
import { recoverable } from "./recover.js";

/** The `Recovery` service; `runOnce` (one plain role-task run) is injected by the app so recovery never imports orchestration. */
export function createRecovery(runOnce: RunTaskOnce): Recovery {
  return {
    sizeHint: SIZE_HINT,
    state: ensureRecovery,
    log: logRecovery,
    brain: recoveryBrain,
    runTask: recoverable(runOnce),
  };
}

import type { HostPort } from "../ports.js";
import type { Json, Tool, ToolPreview } from "../tools/types.js";
import type { LeaseManager } from "./leases.js";

const PATH_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch"]);

export class LeaseCycleError extends Error {
  constructor(readonly victim: string, readonly path: string) {
    super(`lease cycle on ${path}; re-queue ${victim}`);
    this.name = "LeaseCycleError";
  }
}

export class LeaseTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`lease wait timed out on ${path}`);
    this.name = "LeaseTimeoutError";
  }
}

function snapshotName(path: string): string {
  return path.replace(/[\\/]/g, "__");
}

/**
 * Write-tool wrapper for one task: takes a per-file lease before executing
 * (declared or on demand), records a pre-image snapshot once per run, and
 * releases on task end via the scheduler. Reads are never blocked.
 */
export function leasedTools(
  tools: Tool[],
  deps: {
    host: HostPort;
    leases: LeaseManager;
    taskId: string;
    runId: string;
    leaseWaitMs: number;
    stateDir: string;
    onWait?(path: string, holder: string): void;
  },
): Tool[] {
  const snapshotted = new Set<string>();
  return tools.map((tool) => {
    if (!PATH_TOOLS.has(tool.spec.name)) return tool;
    const base = tool.execute.bind(tool);
    const basePreview = tool.preview?.bind(tool);
    return {
      spec: tool.spec,
      requiresApproval: tool.requiresApproval,
      awaitsUser: tool.awaitsUser,
      coreHandled: tool.coreHandled,
      parallel: tool.parallel,
      preview: basePreview ? (args: Json) => basePreview(args) : undefined,
      async execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string> {
        const path = args.path;
        if (typeof path !== "string") return base(args, preview, signal);
        const lease = await deps.leases.acquire(path, deps.taskId, deps.leaseWaitMs, (holder) => deps.onWait?.(path, holder));
        if (lease.kind === "cycle") throw new LeaseCycleError(lease.victim, path);
        if (lease.kind === "timeout") throw new LeaseTimeoutError(path);
        if (!snapshotted.has(path)) {
          snapshotted.add(path);
          try {
            if (await deps.host.files.exists(path)) {
              const before = await deps.host.files.read(path);
              await deps.host.files.writeAtomic(`${deps.stateDir}/scratch/${deps.runId}/snapshots/${snapshotName(path)}`, before.content);
            }
          } catch {
            /* snapshot is best-effort; a missing pre-image must not block the write */
          }
        }
        return base(args, preview, signal);
      },
    } as Tool;
  });
}

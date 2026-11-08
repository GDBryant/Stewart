import type { HostPort, Json } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import type { LeaseManager } from "@stewart/scheduling";
import { LeaseCycleError, LeaseTimeoutError, recordPreImage } from "@stewart/run-state";
import { PATH_TOOLS } from "./types.js";
import type { Tool } from "./types.js";

/**
 * Write-tool wrapper for one task: takes a per-file lease before executing
 * (declared or on demand), records a pre-image snapshot once per run, and
 * releases on task end via the scheduler. Reads are never blocked.
 */
export function leasedTools(
  tools: Tool[],
  deps: {
    host: Pick<HostPort, "files">;
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
      category: tool.category,
      awaitsUser: tool.awaitsUser,
      coreHandled: tool.coreHandled,
      parallel: tool.parallel,
      preview: basePreview ? (args: Json) => basePreview(args) : undefined,
      async execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string | { text: string; images?: string[] }> {
        const path = args.path;
        if (typeof path !== "string") return base(args, preview, signal);
        const currentHolder = deps.leases.holder(path);
        let waited = false;
        const lease = await deps.leases.acquire(path, deps.taskId, deps.leaseWaitMs, (holder) => {
          waited = true;
          deps.onWait?.(path, holder);
        });
        if (lease.kind === "cycle") throw new LeaseCycleError(lease.victim, path, currentHolder ?? deps.leases.holder(path));
        if (lease.kind === "timeout") throw new LeaseTimeoutError(path);
        const effectivePreview = waited && basePreview && preview?.kind === "file" ? await basePreview(args) : preview;
        if (!snapshotted.has(path)) {
          snapshotted.add(path);
          await recordPreImage(deps.host, deps.stateDir, deps.runId, path).catch(() => {
            /* snapshot is best-effort; a missing pre-image must not block the write */
          });
        }
        return base(args, effectivePreview, signal);
      },
    } as Tool;
  });
}

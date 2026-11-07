import type { HostPort } from "@stewart/kernel";
import type { Json } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import type { Tool } from "../tools/types.js";
import type { LeaseManager } from "@stewart/scheduling";

const PATH_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);

export class LeaseCycleError extends Error {
  constructor(
    readonly victim: string,
    readonly path: string,
    readonly holder?: string,
  ) {
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

export function snapshotName(path: string): string {
  return path.replace(/[\\/]/g, "__");
}

export interface SnapshotManifestEntry {
  path: string;
  existed: boolean;
  snap: string;
}

/**
 * Restore all files modified or created during `runId` back to their pre-run
 * state using `.stewart/scratch/<runId>/snapshots/`.
 */
export async function revertRunSnapshots(host: Pick<HostPort, "files">, stateDir: string, runId: string): Promise<string[]> {
  const dir = `${stateDir}/scratch/${runId}/snapshots`;
  const lines = await host.files.readLines(`${dir}/manifest.jsonl`);
  const firstByPath = new Map<string, SnapshotManifestEntry>();
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as SnapshotManifestEntry;
      if (typeof e.path === "string" && !firstByPath.has(e.path)) firstByPath.set(e.path, e);
    } catch {
      /* ignore corrupt line */
    }
  }
  const restored: string[] = [];
  for (const entry of firstByPath.values()) {
    if (entry.existed) {
      const snapPath = `${dir}/${entry.snap}`;
      if (await host.files.exists(snapPath)) {
        const before = await host.files.read(snapPath);
        await host.files.edit({ path: entry.path, content: before.content });
        restored.push(entry.path);
      }
    } else {
      await host.files.delete(entry.path);
      restored.push(entry.path);
    }
  }
  return restored;
}

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
          try {
            const dir = `${deps.stateDir}/scratch/${deps.runId}/snapshots`;
            const snap = snapshotName(path);
            const snapFile = `${dir}/${snap}`;
            const createdMarker = `${dir}/${snap}.created`;
            const alreadyRecorded = (await deps.host.files.exists(snapFile)) || (await deps.host.files.exists(createdMarker));
            if (!alreadyRecorded) {
              const existed = await deps.host.files.exists(path);
              if (existed) {
                const before = await deps.host.files.read(path);
                await deps.host.files.writeAtomic(snapFile, before.content);
              } else {
                await deps.host.files.writeAtomic(createdMarker, "");
              }
              await deps.host.files.appendLine(`${dir}/manifest.jsonl`, JSON.stringify({ path, existed, snap }));
            }
          } catch {
            /* snapshot is best-effort; a missing pre-image must not block the write */
          }
        }
        return base(args, effectivePreview, signal);
      },
    } as Tool;
  });
}

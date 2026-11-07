import type { HostPort } from "@stewart/kernel";

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
 * Record a pre-image of `path` once per run (or a `.created` marker when it did not exist) so
 * `revertRunSnapshots` can restore it. Best-effort: callers must not let a failure block the write.
 */
export async function recordPreImage(host: Pick<HostPort, "files">, stateDir: string, runId: string, path: string): Promise<void> {
  const dir = `${stateDir}/scratch/${runId}/snapshots`;
  const snap = snapshotName(path);
  const snapFile = `${dir}/${snap}`;
  const createdMarker = `${dir}/${snap}.created`;
  if ((await host.files.exists(snapFile)) || (await host.files.exists(createdMarker))) return;
  const existed = await host.files.exists(path);
  if (existed) {
    const before = await host.files.read(path);
    await host.files.writeAtomic(snapFile, before.content);
  } else {
    await host.files.writeAtomic(createdMarker, "");
  }
  await host.files.appendLine(`${dir}/manifest.jsonl`, JSON.stringify({ path, existed, snap }));
}

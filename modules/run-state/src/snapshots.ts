import { StewartError, ok, err, type HostPort, type Result } from "@stewart/kernel";

export class LeaseCycleError extends StewartError {
  constructor(
    readonly victim: string,
    readonly path: string,
    readonly holder?: string,
  ) {
    super("lease_cycle", `lease cycle on ${path}; re-queue ${victim}`);
    this.name = "LeaseCycleError";
  }
}

export class LeaseTimeoutError extends StewartError {
  constructor(readonly path: string) {
    super("lease_timeout", `lease wait timed out on ${path}`);
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
export async function revertRunSnapshots(host: Pick<HostPort, "files">, stateDir: string, runId: string): Promise<Result<string[]>> {
  const dir = `${stateDir}/scratch/${runId}/snapshots`;
  const lines = await host.files.readLines(`${dir}/manifest.jsonl`);
  const restored: string[] = [];
  for (const entry of firstEntryPerPath(lines)) {
    try {
      if (await restoreEntry(host, dir, entry)) restored.push(entry.path);
    } catch (e) {
      return err("revert_failed", `revert failed on ${entry.path}: ${e instanceof Error ? e.message : e}`, e);
    }
  }
  return ok(restored);
}

/** First manifest entry per path, in first-seen order; corrupt lines and entries without a string path are skipped. */
export function firstEntryPerPath(lines: string[]): SnapshotManifestEntry[] {
  const firstByPath = new Map<string, SnapshotManifestEntry>();
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as SnapshotManifestEntry;
      if (typeof e.path === "string" && !firstByPath.has(e.path)) firstByPath.set(e.path, e);
    } catch {
      /* ignore corrupt line */
    }
  }
  return [...firstByPath.values()];
}

/** Restore one entry; returns false when a pre-image was expected but its snapshot file is missing. */
async function restoreEntry(host: Pick<HostPort, "files">, dir: string, entry: SnapshotManifestEntry): Promise<boolean> {
  if (!entry.existed) {
    await host.files.delete(entry.path);
    return true;
  }
  const snapPath = `${dir}/${entry.snap}`;
  if (!(await host.files.exists(snapPath))) return false;
  const before = await host.files.read(snapPath);
  await host.files.edit({ path: entry.path, content: before.content });
  return true;
}

/**
 * Record a pre-image of `path` once per run (or a `.created` marker when it did not exist) so
 * `revertRunSnapshots` can restore it. Best-effort: callers must not let a failure block the write.
 */
export async function recordPreImage(host: Pick<HostPort, "files">, stateDir: string, runId: string, path: string): Promise<Result<void>> {
  try {
    const dir = `${stateDir}/scratch/${runId}/snapshots`;
    const snap = snapshotName(path);
    const snapFile = `${dir}/${snap}`;
    const createdMarker = `${dir}/${snap}.created`;
    if ((await host.files.exists(snapFile)) || (await host.files.exists(createdMarker))) return ok(undefined);
    const existed = await host.files.exists(path);
    if (existed) {
      const before = await host.files.read(path);
      await host.files.writeAtomic(snapFile, before.content);
    } else {
      await host.files.writeAtomic(createdMarker, "");
    }
    await host.files.appendLine(`${dir}/manifest.jsonl`, JSON.stringify({ path, existed, snap }));
    return ok(undefined);
  } catch (e) {
    return err("snapshot_failed", `pre-image failed for ${path}: ${e instanceof Error ? e.message : e}`, e);
  }
}

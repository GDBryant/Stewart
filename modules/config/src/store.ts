import { createHash } from "node:crypto";
import type { ConfigLayer } from "./loader.js";

/** Host-supplied config persistence. read() returns raw YAML per file;
 * write() must persist atomically (temp file + rename). */
export interface ConfigStore {
  read(): Promise<ConfigLayer>;
  write(file: string, yaml: string): Promise<void>;
  /** Remove a file (skill resets). Absent = file is a no-op. */
  delete?(file: string): Promise<void>;
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Tracks content hashes written by Stewart so file-watcher echoes are suppressed. */
export class SelfWriteGuard {
  private hashes = new Map<string, string>();

  recordWrite(file: string, content: string): void {
    this.hashes.set(file, hashContent(content));
  }

  recordDelete(file: string): void {
    this.hashes.delete(file);
  }

  isSelfWrite(file: string, content: string | undefined): boolean {
    if (content === undefined) return !this.hashes.has(file);
    return this.hashes.get(file) === hashContent(content);
  }

  layerUnchanged(layer: ConfigLayer): boolean {
    const entries = Object.entries(layer).filter(([, v]) => v !== undefined);
    if (entries.length !== this.hashes.size) return false;
    return entries.every(([k, v]) => this.hashes.get(k) === hashContent(v!));
  }

  syncLayer(layer: ConfigLayer): void {
    this.hashes.clear();
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) this.hashes.set(k, hashContent(v));
    }
  }
}

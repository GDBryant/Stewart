import { splitShellPrograms } from "./shell.js";
import type { ToolPreview } from "./preview.js";

export type GrantScope = "chat" | "always";
export type GrantDecision = "once" | "chat" | "always" | "deny";

export interface AuditEntry {
  decision: GrantDecision | "auto";
  category: string;
  target: string;
}

export function isScratchPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.?\//, "");
  return norm === "scratch" || norm.startsWith("scratch/") || norm === ".stewart/scratch" || norm.startsWith(".stewart/scratch/");
}

/**
 * Per-run (chat scope) and per-session (always scope) grants. Program grants
 * cover a command only when every program it launches is granted.
 */
export class Grants {
  private chatCats = new Set<string>();
  private chatProgs = new Set<string>();
  private alwaysCats = new Set<string>();
  private alwaysProgs = new Set<string>();
  readonly audit: AuditEntry[] = [];

  isGranted(category: string, preview: ToolPreview | null): boolean {
    if (preview?.kind === "file" && isScratchPath(preview.path)) {
      this.audit.push({ decision: "auto", category, target: preview.path });
      return true;
    }
    if (this.chatCats.has(category) || this.alwaysCats.has(category)) return true;
    if (preview?.kind === "command") {
      const progs = splitShellPrograms(preview.command);
      if (progs != null && progs.every((p) => this.chatProgs.has(p) || this.alwaysProgs.has(p))) return true;
    }
    return false;
  }

  record(scope: GrantScope, category: string, preview: ToolPreview | null): void {
    const cats = scope === "chat" ? this.chatCats : this.alwaysCats;
    const progs = scope === "chat" ? this.chatProgs : this.alwaysProgs;
    const target = preview?.kind === "file" ? preview.path : preview?.kind === "command" ? preview.command : category;
    this.audit.push({ decision: scope, category, target });
    if (preview?.kind === "command") {
      const ps = splitShellPrograms(preview.command);
      if (ps != null) {
        for (const p of ps) progs.add(p);
        return;
      }
    }
    cats.add(category);
  }

  revoke(scope?: GrantScope, category?: string): void {
    if (!scope || scope === "chat") {
      if (category) this.chatCats.delete(category);
      else {
        this.chatCats.clear();
        this.chatProgs.clear();
      }
    }
    if (!scope || scope === "always") {
      if (category) this.alwaysCats.delete(category);
      else {
        this.alwaysCats.clear();
        this.alwaysProgs.clear();
      }
    }
  }
}

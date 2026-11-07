import * as path from "node:path";
import type { HostPort } from "@stewart/kernel";

export const MAX_FIND_RESULTS = 500;
export const MAX_SEARCH_RESULTS = 200;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_COMMAND_OUTPUT = 200_000;

/**
 * Workspace path resolution. `base` is the first workspace root (absolute).
 * Model-supplied paths resolve to workspace-relative paths; escapes and
 * denied dirs (.git/, .stewart/) are rejected.
 */
export class ProjectPaths {
  private constructor(
    private readonly host: Pick<HostPort, "files" | "workspace">,
    readonly base: string,
  ) {}

  static async forProject(host: Pick<HostPort, "files" | "workspace">): Promise<ProjectPaths> {
    const roots = await host.workspace.roots();
    return new ProjectPaths(host, roots[0] ?? ".");
  }

  /** Resolve a model path to a workspace-relative path. */
  resolve(raw: string): string {
    const clean = raw.replace(/\\/g, "/");
    let abs: string;
    if (this.base === ".") {
      abs = path.posix.normalize(clean.replace(/^\/+/, ""));
      if (abs.startsWith("..") || path.posix.isAbsolute(clean)) throw new Error(`path escapes workspace: ${raw}`);
    } else {
      abs = path.posix.normalize(path.posix.isAbsolute(clean) ? clean : path.posix.join(this.base, clean));
      if (abs !== this.base && !abs.startsWith(`${this.base}/`)) throw new Error(`path escapes workspace: ${raw}`);
    }
    const rel = this.base === "." ? abs : abs === this.base ? "." : abs.slice(this.base.length + 1);
    this.checkDenied(rel);
    return rel;
  }

  absolute(rel: string): string {
    return this.base === "." ? rel : path.posix.join(this.base, rel);
  }

  private checkDenied(rel: string): void {
    const norm = rel.replace(/\\/g, "/");
    const first = norm.split("/")[0];
    if (first === ".git") throw new Error(`path denied: ${rel}`);
    if (first === ".stewart" && norm !== ".stewart/scratch" && !norm.startsWith(".stewart/scratch/")) {
      throw new Error(`path denied: ${rel}`);
    }
  }

  exists(rel: string): Promise<boolean> {
    return this.host.files.exists(rel);
  }
  list(dir: string): Promise<string[]> {
    return this.host.files.list(dir);
  }
  read(rel: string): Promise<{ content: string; version?: number }> {
    return this.host.files.read(rel);
  }
  stat(rel: string): Promise<{ size: number }> {
    return this.host.files.stat(rel);
  }
}

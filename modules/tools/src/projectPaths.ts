import * as fsp from "node:fs/promises";
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
  private canonRoots?: Promise<string[]>;

  private constructor(
    private readonly host: Pick<HostPort, "files" | "workspace">,
    readonly base: string,
    private readonly readRoots: string[] = [],
  ) {}

  static async forProject(host: Pick<HostPort, "files" | "workspace">, opts: { readRoots?: string[] } = {}): Promise<ProjectPaths> {
    const roots = await host.workspace.roots();
    return new ProjectPaths(host, roots[0] ?? ".", opts.readRoots ?? []);
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

  async resolveRead(raw: string): Promise<string> {
    const clean = raw.replace(/\\/g, "/");
    if (!path.posix.isAbsolute(clean)) return this.resolve(raw);
    const abs = path.posix.normalize(clean);
    if (this.base !== "." && (abs === this.base || abs.startsWith(`${this.base}/`))) return this.resolve(raw);
    return this.resolveExternal(abs);
  }

  private async resolveExternal(abs: string): Promise<string> {
    const roots = await this.canonicalRoots();
    if (roots.length === 0) {
      throw new Error(`absolute path outside workspace needs the readRoots capability: ${abs} — enable via .stewart/project.yaml readRoots`);
    }
    const real = await fsp.realpath(abs).catch(() => null);
    if (!real) throw new Error(`file not found: ${abs}`);
    const canon = real.replace(/\\/g, "/");
    if (roots.some((r) => canon === r || canon.startsWith(`${r}/`))) return canon;
    throw new Error(`path outside configured readRoots: ${abs} (grant the dir via .stewart/project.yaml readRoots)`);
  }

  private canonicalRoots(): Promise<string[]> {
    this.canonRoots ??= Promise.all(this.readRoots.map((r) => fsp.realpath(r).then((p) => p.replace(/\\/g, "/"), () => null))).then(
      (rs) => rs.filter((r): r is string => r !== null),
    );
    return this.canonRoots;
  }

  absolute(rel: string): string {
    return this.base === "." ? rel : path.posix.join(this.base, rel);
  }

  private checkDenied(rel: string): void {
    const reason = deniedDirReason(rel);
    if (reason) throw new Error(reason);
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

/** Deny reason for a workspace-relative path inside a denied dir, or null. `.stewart/scratch/` is allowed. */
export function deniedDirReason(rel: string): string | null {
  const norm = rel.replace(/\\/g, "/");
  const first = norm.split("/")[0];
  if (first === ".git") return `path denied: ${rel}`;
  if (first === ".stewart" && norm !== ".stewart/scratch" && !norm.startsWith(".stewart/scratch/")) return `path denied: ${rel}`;
  return null;
}

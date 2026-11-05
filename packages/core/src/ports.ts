/**
 * HostPort: the only host-specific surface. Core never touches project files,
 * secrets or processes directly. VS Code implements this with the vscode API;
 * JetBrains implements it over stdio JSON-RPC to the Kotlin plugin.
 */
export interface VersionedEdit {
  /** Path relative to a workspace root. */
  path: string;
  /** Expected document version; stale → fail before applying. */
  baseVersion?: number;
  /** Unified-diff-free op set: replace whole file or apply anchored edits. */
  content?: string;
  edits?: { oldText: string; newText: string }[];
}

export interface ProcessHandle {
  /** Write to stdin (optional). */
  write?(data: string): void;
  /** SIGTERM equivalent. */
  cancel(): void;
  /** Kill the whole process tree. */
  killTree(): Promise<void>;
  readonly done: Promise<{ code: number }>;
}

export interface HostPort {
  secrets: {
    get(ref: string): Promise<string | undefined>;
    set(ref: string, value: string): Promise<void>;
    delete(ref: string): Promise<void>;
  };
  files: {
    read(path: string): Promise<{ content: string; version?: number }>;
    edit(edit: VersionedEdit): Promise<{ applied: true; version?: number }>;
    /** Post-write verification. */
    readBack(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
    /** Recursive relative paths under dir (workspace-relative), capped by host. */
    list(dir: string): Promise<string[]>;
    stat(path: string): Promise<{ size: number }>;
    writeAtomic(path: string, content: string): Promise<void>;
    /** Append one line and fsync (ledger, idempotency log). */
    appendLine(path: string, line: string): Promise<void>;
    /** All lines of an append-only file; absent file → []. */
    readLines(path: string): Promise<string[]>;
    /** Remove a file; absent is not an error. */
    delete(path: string): Promise<void>;
  };
  proc: {
    run(argv: string[], opts: { cwd: string; env?: Record<string, string>; onData(d: string): void }): ProcessHandle;
  };
  diff: {
    preview(path: string, next: string): Promise<void>;
  };
  diag: {
    problems(path?: string): Promise<{ path: string; line: number; message: string; severity: string }[]>;
  };
  workspace: {
    roots(): Promise<string[]>;
    stateDir(): Promise<string>;
    trusted(): Promise<boolean>;
  };
  log(line: string): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export interface IdGen {
  next(prefix: string): string;
}

export type FetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
};
export type Fetcher = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  },
};

export function counterIds(): IdGen {
  let n = 0;
  return { next: (p) => `${p}-${++n}` };
}

export const nodeFetch: Fetcher = async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: r.status, headers, body: r.body };
};

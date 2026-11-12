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

/** Narrow ports: modules ask for the slice they use (`Pick<HostPort, "files">`), so tests stub one member. */
export interface SecretsPort {
  secrets: {
    get(ref: string): Promise<string | undefined>;
    set(ref: string, value: string): Promise<void>;
    delete(ref: string): Promise<void>;
  };
}

export interface FilesPort {
  files: {
    read(path: string): Promise<{ content: string; version?: number }>;
    edit(edit: VersionedEdit): Promise<{ applied: true; version?: number }>;
    /** Post-write verification. */
    readBack(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
    /** Recursive relative paths under dir (workspace-relative), capped by host. */
    list(dir: string): Promise<string[]>;
    stat(path: string): Promise<{ size: number }>;
    /** Raw bytes as base64 (images, binary assets). */
    readBinary(path: string): Promise<{ base64: string; size: number }>;
    /** Write raw bytes from base64; replaces the file atomically. */
    writeBinary(path: string, base64: string): Promise<void>;
    writeAtomic(path: string, content: string): Promise<void>;
    /** Append one line and fsync (ledger). */
    appendLine(path: string, line: string): Promise<void>;
    /** All lines of an append-only file; absent file → []. */
    readLines(path: string): Promise<string[]>;
    /** Remove a file; absent is not an error. */
    delete(path: string): Promise<void>;
  };
}

export interface ProcessPort {
  proc: {
    run(argv: string[], opts: { cwd: string; env?: Record<string, string>; onData(d: string): void }): ProcessHandle;
  };
}

export interface EditorPort {
  diff: {
    preview(path: string, next: string): Promise<void>;
  };
  editor: {
    /** Active editor selection, or null when nothing is selected. */
    selection(): Promise<{ path: string; text: string; startLine: number; endLine: number } | null>;
  };
}

export interface ProblemsPort {
  diag: {
    problems(path?: string): Promise<{ path: string; line: number; message: string; severity: string }[]>;
  };
}

export interface WorkspacePort {
  workspace: {
    roots(): Promise<string[]>;
    stateDir(): Promise<string>;
    trusted(): Promise<boolean>;
  };
}

export interface LogPort {
  log(line: string): void;
}

/** Everything a host implements. */
export type HostPort = SecretsPort & FilesPort & ProcessPort & EditorPort & ProblemsPort & WorkspacePort & LogPort;

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

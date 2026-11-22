import type { Fetcher, FetchResponse, HostPort, ProcessHandle } from "./ports.js";

export interface FsEntry {
  content: string;
}

function fakeBinaryFiles(files: Record<string, string>): Pick<HostPort["files"], "readBinary" | "writeBinary"> {
  return {
    readBinary: async (p) => {
      if (!(p in files)) throw new Error(`file not found: ${p}`);
      const raw = files[p];
      const b64 = raw.startsWith("\0b64:") ? raw.slice(5) : Buffer.from(raw, "utf8").toString("base64");
      return { base64: b64, size: Buffer.from(b64, "base64").byteLength };
    },
    writeBinary: async (p, b64) => {
      files[p] = `\0b64:${b64}`;
    },
  };
}

function fakeReadFiles(files: Record<string, string>): Pick<HostPort["files"], "read" | "readBack" | "stat" | "readLines"> {
  return {
    read: async (p) => {
      if (!(p in files)) throw new Error(`file not found: ${p}`);
      return { content: files[p] };
    },
    readBack: async (p) => files[p],
    stat: async (p) => {
      if (!(p in files)) throw new Error(`file not found: ${p}`);
      return { size: files[p].length };
    },
    readLines: async (p) => (files[p] ? files[p].split("\n").filter((l) => l.length > 0) : []),
  };
}

function fakeWriteFiles(files: Record<string, string>, edits: { path: string; content?: string; edits?: { oldText: string; newText: string }[] }[]): Pick<HostPort["files"], "edit" | "writeAtomic" | "appendLine" | "delete"> {
  return {
    edit: async (e) => {
      if (!(e.path in files)) throw new Error(`file not found: ${e.path}`);
      edits.push(e);
      if (e.content !== undefined) files[e.path] = e.content;
      else for (const ed of e.edits ?? []) files[e.path] = files[e.path].replace(ed.oldText, ed.newText);
      return { applied: true as const };
    },
    writeAtomic: async (p, c) => {
      files[p] = c;
    },
    appendLine: async (p, line) => {
      files[p] = files[p] ? `${files[p]}\n${line}` : line;
    },
    delete: async (p) => {
      delete files[p];
    },
  };
}

function fakeQueryFiles(files: Record<string, string>): Pick<HostPort["files"], "exists" | "list"> {
  return {
    exists: async (p) => p === "." || p === "" || p in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)),
    list: async (dir) => {
      const prefix = dir === "." || dir === "" ? "" : `${dir}/`;
      return Object.keys(files).filter((k) => k.startsWith(prefix));
    },
  };
}

function fakeFiles(files: Record<string, string>, edits: { path: string; content?: string; edits?: { oldText: string; newText: string }[] }[]): HostPort["files"] {
  return {
    ...fakeBinaryFiles(files),
    ...fakeReadFiles(files),
    ...fakeWriteFiles(files, edits),
    ...fakeQueryFiles(files),
  };
}

type ProcHandler = (argv: string[], onData: (d: string) => void, signal: AbortSignal) => { code: number; cause?: string } | "never";

/** Process port that records every spawn in `procs` and resolves via the current handler (default exit 0). */
function fakeProc(procs: { argv: string[]; killed: boolean }[], getHandler: () => ProcHandler | null): HostPort["proc"] {
  return {
    run: (argv, popts): ProcessHandle => {
      const entry = { argv, killed: false };
      procs.push(entry);
      let doneResolve: (r: { code: number; cause?: string }) => void = () => {};
      const done = new Promise<{ code: number; cause?: string }>((res) => {
        doneResolve = res;
      });
      const kill = async () => {
        entry.killed = true;
        doneResolve({ code: -1 });
      };
      const h = getHandler()?.(argv, popts.onData, new AbortController().signal) ?? { code: 0 };
      if (h === "never") return { cancel: () => {}, killTree: kill, done };
      queueMicrotask(() => doneResolve(h));
      return { cancel: () => {}, killTree: kill, done };
    },
  };
}

function fakeDiff(diffShows: { path: string; before?: string; after?: string }[]): HostPort["diff"] {
  return {
    preview: async () => {},
    show: async (path, before, after) => void diffShows.push({ path, before, after }),
  };
}

export function fakeHost(files: Record<string, string> = {}, opts: { trusted?: boolean; roots?: string[] } = {}) {
  const procs: { argv: string[]; killed: boolean }[] = [];
  let procHandler: ProcHandler | null = null;
  const edits: { path: string; content?: string; edits?: { oldText: string; newText: string }[] }[] = [];
  let problems: { path: string; line: number; message: string; severity: string }[] = [];
  let selection: { path: string; text: string; startLine: number; endLine: number } | null = null;
  const diffShows: { path: string; before?: string; after?: string }[] = [];
  const host: HostPort = {
    secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    files: fakeFiles(files, edits),
    proc: fakeProc(procs, () => procHandler),
    diff: fakeDiff(diffShows),
    diag: { problems: async () => problems },
    editor: { selection: async () => selection },
    workspace: {
      roots: async () => opts.roots ?? ["/p"],
      stateDir: async () => "/tmp/st",
      trusted: async () => opts.trusted ?? true,
    },
    log: () => {},
  };
  return {
    host,
    procs,
    edits,
    files,
    diffShows,
    setProcHandler: (h: typeof procHandler) => {
      procHandler = h;
    },
    setProblems: (p: typeof problems) => {
      problems = p;
    },
    setSelection: (s: typeof selection) => {
      selection = s;
    },
  };
}

export function streamOf(lines: string[], chunkDelay = 0): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const l of lines) {
        c.enqueue(enc.encode(l + "\n"));
        if (chunkDelay) await new Promise((r) => setTimeout(r, chunkDelay));
      }
      c.close();
    },
  });
}

export function fakeFetcher(responses: { status?: number; body?: string | string[]; headers?: Record<string, string> }[]): { fetcher: Fetcher; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  let i = 0;
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, body: init.body });
    const spec = responses[Math.min(i++, responses.length - 1)];
    const body = Array.isArray(spec.body) ? streamOf(spec.body) : streamOf(spec.body ? [spec.body] : []);
    return { status: spec.status ?? 200, headers: spec.headers ?? {}, body };
  };
  return { fetcher, calls };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

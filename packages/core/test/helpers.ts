import type { Fetcher, FetchResponse, HostPort, ProcessHandle } from "../src/ports.js";

export interface FsEntry {
  content: string;
}

export function fakeHost(files: Record<string, string> = {}, opts: { trusted?: boolean; roots?: string[] } = {}) {
  const procs: { argv: string[]; killed: boolean }[] = [];
  let procHandler: ((argv: string[], onData: (d: string) => void, signal: AbortSignal) => { code: number } | "never") | null = null;
  const edits: { path: string; content?: string; edits?: { oldText: string; newText: string }[] }[] = [];
  const host: HostPort = {
    secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    files: {
      read: async (p) => {
        if (!(p in files)) throw new Error(`file not found: ${p}`);
        return { content: files[p] };
      },
      edit: async (e) => {
        edits.push(e);
        if (e.content !== undefined) files[e.path] = e.content;
        else for (const ed of e.edits ?? []) files[e.path] = files[e.path].replace(ed.oldText, ed.newText);
        return { applied: true as const };
      },
      readBack: async (p) => files[p],
      exists: async (p) => p === "." || p === "" || p in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)),
      list: async (dir) => {
        const prefix = dir === "." || dir === "" ? "" : `${dir}/`;
        return Object.keys(files).filter((k) => k.startsWith(prefix));
      },
      stat: async (p) => {
        if (!(p in files)) throw new Error(`file not found: ${p}`);
        return { size: files[p].length };
      },
      writeAtomic: async (p, c) => {
        files[p] = c;
      },
    },
    proc: {
      run: (argv, popts): ProcessHandle => {
        const entry = { argv, killed: false };
        procs.push(entry);
        let doneResolve: (r: { code: number }) => void = () => {};
        const done = new Promise<{ code: number }>((res) => {
          doneResolve = res;
        });
        const kill = async () => {
          entry.killed = true;
          doneResolve({ code: -1 });
        };
        const h = procHandler?.(argv, popts.onData, new AbortController().signal) ?? { code: 0 };
        if (h === "never") return { cancel: () => {}, killTree: kill, done };
        queueMicrotask(() => doneResolve(h));
        return { cancel: () => {}, killTree: kill, done };
      },
    },
    diff: { preview: async () => {} },
    diag: { problems: async () => [] },
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
    setProcHandler: (h: typeof procHandler) => {
      procHandler = h;
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

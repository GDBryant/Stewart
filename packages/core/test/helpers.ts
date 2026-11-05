import type { Fetcher, FetchResponse } from "../src/ports.js";

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

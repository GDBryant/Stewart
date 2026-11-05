const decoder = new TextDecoder();

/** Iterate complete lines from a byte stream. Enforces stall timeout between chunks. */
export async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal, stallMs: number): AsyncGenerator<string> {
  const reader = body.getReader();
  let buf = "";
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("stream stall timeout")), stallMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
      if (signal.aborted) return;
    }
    const tail = buf.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Parse one SSE line group: yields each `data:` payload, skipping `[DONE]`. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal, stallMs: number): AsyncGenerator<string> {
  for await (const line of lines(body, signal, stallMs)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    if (data) yield data;
  }
}

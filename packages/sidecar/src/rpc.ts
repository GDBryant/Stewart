/**
 * NDJSON JSON-RPC over a byte stream pair. Requests flow both ways: the IDE asks
 * core, and core asks the IDE for HostPort work. Framing is one JSON object per
 * line; a line over `maxLineBytes` is rejected rather than buffered.
 */
export type RpcRequest = { id: number; method: string; params?: unknown };
export type RpcResponse = { id: number; result?: unknown; error?: { message: string; code?: string } };
export type RpcNotification = { method: string; params?: unknown };
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function isRequest(m: RpcMessage): m is RpcRequest {
  return typeof (m as RpcRequest).id === "number" && typeof (m as RpcRequest).method === "string";
}

export function isResponse(m: RpcMessage): m is RpcResponse {
  return typeof (m as RpcResponse).id === "number" && (m as RpcRequest).method === undefined;
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export class RpcLink {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private buffer = "";
  private requestHandler: RequestHandler = async () => {
    throw new Error("no request handler");
  };
  private notificationHandlers: NotificationHandler[] = [];
  closed = false;

  constructor(
    private write: (line: string) => void,
    private maxLineBytes = MAX_LINE_BYTES,
  ) {}

  onRequest(h: RequestHandler): void {
    this.requestHandler = h;
  }

  onNotification(h: NotificationHandler): void {
    this.notificationHandlers.push(h);
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(JSON.stringify({ method, params }));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("rpc link closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write(JSON.stringify({ id, method, params }));
    });
  }

  /** Feed raw bytes; partial lines are buffered until their newline arrives. */
  feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) {
        if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) this.notify("protocol.error", { message: "rpc line too large" });
        else this.dispatch(line);
      }
      nl = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      this.buffer = "";
      this.notify("protocol.error", { message: "rpc line too large" });
      this.fail(new Error("rpc line too large"));
    }
  }

  close(reason = "closed"): void {
    this.closed = true;
    this.fail(new Error(reason));
  }

  private fail(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      this.notify("protocol.error", { message: "malformed JSON line" });
      return;
    }
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (isRequest(msg)) {
      void this.requestHandler(msg.method, msg.params).then(
        (result) => this.write(JSON.stringify({ id: msg.id, result: result ?? null })),
        (e: unknown) => this.write(JSON.stringify({ id: msg.id, error: { message: e instanceof Error ? e.message : String(e) } })),
      );
      return;
    }
    if (typeof msg.method === "string") for (const h of this.notificationHandlers) h(msg.method, msg.params);
  }
}

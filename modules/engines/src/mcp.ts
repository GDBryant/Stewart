import http from "node:http";
import { randomBytes } from "node:crypto";
import type { Json } from "@stewart/kernel";
import type { ToolRegistry } from "@stewart/tools";

export interface McpHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL = "2025-06-18";

function result(id: Rpc["id"], r: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: r });
}

function rpcError(id: Rpc["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function callTool(reg: ToolRegistry, params: Record<string, unknown> | undefined, signal: AbortSignal): Promise<string> {
  const name = String(params?.name ?? "");
  const args = (params?.arguments ?? {}) as Json;
  const bad = reg.validate({ id: "mcp", name, arguments: args });
  if (bad) return JSON.stringify({ content: [{ type: "text", text: bad }], isError: true });
  try {
    const out = await reg.find(name)!.execute(args, null, signal);
    const text = typeof out === "string" ? out : out.text;
    return JSON.stringify({ content: [{ type: "text", text }], isError: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ content: [{ type: "text", text: msg }], isError: true });
  }
}

async function handle(rpc: Rpc, reg: ToolRegistry, signal: AbortSignal): Promise<{ status: number; body?: string }> {
  switch (rpc.method) {
    case "initialize":
      return {
        status: 200,
        body: result(rpc.id, {
          protocolVersion: String(rpc.params?.protocolVersion ?? PROTOCOL),
          capabilities: { tools: {} },
          serverInfo: { name: "stewart", version: "3.0.0" },
        }),
      };
    case "notifications/initialized":
      return { status: 202 };
    case "tools/list":
      return { status: 200, body: result(rpc.id, { tools: reg.specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.parameters })) }) };
    case "tools/call":
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: JSON.parse(await callTool(reg, rpc.params, signal)) }) };
    default:
      if (rpc.method.startsWith("notifications/")) return { status: 202 };
      return { status: 200, body: rpcError(rpc.id, -32601, `unknown method '${rpc.method}'`) };
  }
}

/** Minimal MCP streamable-HTTP server exposing the turn's Stewart tools to the Claude CLI. */
export async function startMcp(reg: ToolRegistry, signal: AbortSignal): Promise<McpHandle> {
  const token = randomBytes(24).toString("base64url");
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/mcp") return void res.writeHead(404).end();
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let rpc: Rpc;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(rpcError(null, -32700, "parse error"));
      }
      const out = await handle(rpc, reg, signal);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  signal.addEventListener("abort", () => void close(), { once: true });
  return { url: `http://127.0.0.1:${port}/mcp`, token, close };
}

/** `--mcp-config` value for one stewart server. */
export function mcpConfigArg(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { stewart: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } });
}

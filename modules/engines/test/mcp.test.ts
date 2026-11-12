import { describe, expect, it } from "vitest";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { mcpConfigArg, startMcp } from "../src/mcp.js";

const echo: Tool = {
  spec: {
    name: "echo_tool",
    description: "Echoes the text arg.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
  requiresApproval: false,
  execute: async (args) => `echo:${String(args.text)}`,
};

const boom: Tool = {
  spec: { name: "boom", description: "Always fails.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  requiresApproval: false,
  execute: async () => {
    throw new Error("kaput");
  },
};

async function post(url: string, token: string, body: unknown, auth = true): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("startMcp", () => {
  it("serves initialize, tools/list and tools/call with bearer auth", async () => {
    const reg = new ToolRegistry([echo, boom]);
    const ac = new AbortController();
    const mcp = await startMcp(reg, ac.signal);
    try {
      const init = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } });
      expect(init.status).toBe(200);
      expect(init.json.result).toMatchObject({ protocolVersion: "x", capabilities: { tools: {} }, serverInfo: { name: "stewart" } });

      const note = await post(mcp.url, mcp.token, { jsonrpc: "2.0", method: "notifications/initialized" });
      expect(note.status).toBe(202);

      const list = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (list.json.result as { tools: { name: string; description: string; inputSchema: unknown }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual(["echo_tool", "boom"]);
      expect(tools[0].inputSchema).toMatchObject({ type: "object" });

      const call = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_tool", arguments: { text: "hi" } } });
      expect(call.json.result).toEqual({ content: [{ type: "text", text: "echo:hi" }], isError: false });

      const err = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } });
      expect(err.json.result).toEqual({ content: [{ type: "text", text: "kaput" }], isError: true });

      const bad = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo_tool", arguments: {} } });
      expect((bad.json.result as { isError: boolean }).isError).toBe(true);

      const unknown = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 6, method: "bogus/method" });
      expect((unknown.json.error as { code: number }).code).toBe(-32601);

      const noAuth = await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 7, method: "initialize" }, false);
      expect(noAuth.status).toBe(401);
    } finally {
      await mcp.close();
    }
  });

  it("builds the --mcp-config JSON", () => {
    const cfg = JSON.parse(mcpConfigArg("http://127.0.0.1:9/mcp", "tok")) as { mcpServers: { stewart: { type: string; url: string; headers: { Authorization: string } } } };
    expect(cfg.mcpServers.stewart).toEqual({ type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer tok" } });
  });
});

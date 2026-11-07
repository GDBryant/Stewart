import { describe, expect, it } from "vitest";
import { buildToolsBlock, shimExampleCall, parseToolCalls, type SchemaMap } from "../src/api.js";
import type { ToolSpec } from "@stewart/kernel";

const readFile: ToolSpec = {
  name: "ReadFile",
  description: "read a file",
  parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" } }, required: ["path", "start_line"] },
};
const dispatch: ToolSpec = {
  name: "dispatch",
  description: "send work to a worker",
  parameters: { type: "object", properties: { role: { type: "string" }, dry: { type: "boolean" } }, required: ["role"] },
};

describe("buildToolsBlock", () => {
  it("lists every tool with its description and JSON schema, plus the call format", () => {
    const block = buildToolsBlock([readFile, dispatch]) ?? "";
    expect(block.startsWith("<tools>")).toBe(true);
    expect(block.endsWith("</tools>")).toBe(true);
    expect(block).toContain('"name":"ReadFile"');
    expect(block).toContain('"name":"dispatch"');
    expect(block).toContain("send work to a worker");
    expect(block).toContain(JSON.stringify(readFile.parameters));
    expect(block).toContain("<tool_call>");
    expect(block).toContain("<call>");
    expect(block).toContain("<function=");
  });

  it("returns null when there are no tools (negative)", () => {
    expect(buildToolsBlock([])).toBeNull();
  });

  it("example call uses the first tool and parses with the parser (round trip)", () => {
    const schema: SchemaMap = Object.fromEntries([readFile, dispatch].map((t) => [t.name, t.parameters]));
    const example = shimExampleCall(readFile);
    expect(example).toBe('<tool_call>{"name":"ReadFile","arguments":{"path":"example","start_line":0}}</tool_call>');
    const r = parseToolCalls(example, schema);
    expect(r.calls).toEqual([{ id: expect.any(String), name: "ReadFile", arguments: { path: "example", start_line: 0 } }]);
  });

  it("example for a tool with no required args has empty arguments", () => {
    expect(shimExampleCall({ name: "Noop", description: "", parameters: { type: "object", properties: {} } })).toBe(
      '<tool_call>{"name":"Noop","arguments":{}}</tool_call>',
    );
  });

  it("documented <function=> form parses with the parser (negative: unknown name is not a call)", () => {
    const schema: SchemaMap = { dispatch: dispatch.parameters };
    const ok = parseToolCalls("<function=dispatch><parameter=role>worker</parameter></function>", schema);
    expect(ok.calls).toHaveLength(1);
    const bad = parseToolCalls("<function=nope><parameter=x>1</parameter></function>", schema);
    expect(bad.calls).toHaveLength(0);
  });
});

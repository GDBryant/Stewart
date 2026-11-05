import { describe, expect, it } from "vitest";
import { parseToolCalls, repairNativeCall, ToolCallParseException, type SchemaMap } from "../src/tools/shimParser.js";

const schema: SchemaMap = {
  ReadFile: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" } }, required: ["path"] },
  RunTerminal: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

describe("parseToolCalls", () => {
  it("parses a <tool_call> JSON block with name+arguments", () => {
    const r = parseToolCalls('let me read <tool_call>{"name":"ReadFile","arguments":{"path":"a.ts"}}</tool_call> done', schema);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("ReadFile");
    expect(r.calls[0].arguments).toEqual({ path: "a.ts" });
    expect(r.clean).toBe("let me read  done");
  });

  it("parses a <call> block", () => {
    const r = parseToolCalls('<call>{"name":"ReadFile","arguments":{"path":"b"}}</call>', schema);
    expect(r.calls[0]?.name).toBe("ReadFile");
  });

  it("parses prefix-name json call", () => {
    const r = parseToolCalls('<tool_call>ReadFile {"path":"a"}</tool_call>', schema);
    expect(r.calls[0]?.name).toBe("ReadFile");
    expect(r.calls[0]?.arguments).toEqual({ path: "a" });
  });

  it("parses <function=NAME> with parameter tags and type coercion", () => {
    const r = parseToolCalls(
      '<function=ReadFile><parameter=path>a.ts</parameter><parameter=start_line>3</parameter></function>',
      schema,
    );
    expect(r.calls[0]?.name).toBe("ReadFile");
    expect(r.calls[0]?.arguments).toEqual({ path: "a.ts", start_line: 3 });
  });

  it("parses GLM-style arg_key blocks", () => {
    const r = parseToolCalls(
      '<tool_call>ReadFile<arg_key>path</arg_key>a.ts</tool_call>',
      schema,
    );
    expect(r.calls[0]?.name).toBe("ReadFile");
    expect(r.calls[0]?.arguments).toEqual({ path: "a.ts" });
  });

  it("ignores call blocks inside fences", () => {
    const r = parseToolCalls('```\n<tool_call>{"name":"ReadFile","arguments":{"path":"a"}}</tool_call>\n```', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.clean).toContain("<tool_call>");
  });

  it("ignores blocks naming unknown tools, keeping text", () => {
    const r = parseToolCalls('<tool_call>{"name":"Nope","arguments":{}}</tool_call>', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.clean).toContain("Nope");
  });

  it("keeps text and returns no calls on malformed JSON", () => {
    const r = parseToolCalls('<tool_call>{"name":"ReadFile","arguments":{{{{</tool_call>', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.clean).toContain("ReadFile");
  });

  it("normalizes exec aliases to RunTerminal", () => {
    const r = parseToolCalls('<tool_call>{"name":"execute_command","arguments":{"command":"ls"}}</tool_call>', schema);
    expect(r.calls[0]?.name).toBe("RunTerminal");
    expect(r.calls[0]?.arguments).toEqual({ command: "ls" });
  });

  it("extracts reasoning from think blocks", () => {
    const r = parseToolCalls('<think>hmm</think>answer <tool_call>{"name":"ReadFile","arguments":{"path":"a"}}</tool_call>', schema);
    expect(r.reasoning).toBe("hmm");
    expect(r.calls).toHaveLength(1);
  });

  it("repairs unquoted bare values", () => {
    const r = parseToolCalls('<tool_call>{"name":"ReadFile","arguments":{"path":foo/bar.txt}}</tool_call>', schema);
    expect(r.calls[0]?.arguments).toEqual({ path: "foo/bar.txt" });
  });
});

describe("repairNativeCall", () => {
  it("accepts a named offered function with valid args", () => {
    const calls = repairNativeCall({ id: "x", name: "ReadFile", arguments: '{"path":"a"}' }, schema);
    expect(calls[0]).toMatchObject({ id: "x", name: "ReadFile" });
  });

  it("rejects invalid args for a named function", () => {
    expect(() => repairNativeCall({ name: "ReadFile", arguments: "[1]" }, schema)).toThrow(ToolCallParseException);
    expect(() => repairNativeCall({ name: "ReadFile", arguments: "[1]" }, schema)).toThrow(/TC-ARGS-INVALID/);
  });

  it("repairs an unnamed call embedding tool_call markup", () => {
    const calls = repairNativeCall({
      name: '<tool_call>{"name":"ReadFile","arguments":{"path":"a"}}</tool_call>',
      arguments: "{}",
    }, schema);
    expect(calls[0]?.name).toBe("ReadFile");
  });

  it("rejects calls with no usable name or markup", () => {
    expect(() => repairNativeCall({ name: "Nope", arguments: "{}" }, schema)).toThrow(/TC-NATIVE-INVALID/);
    expect(() => repairNativeCall({ name: " ", arguments: "{}" }, schema)).toThrow(/TC-NATIVE-INVALID/);
  });
});

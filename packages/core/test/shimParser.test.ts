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

describe("parseToolCalls: bare JSON, fenced JSON, Gemma tokens, errors", () => {
  it("parses a bare JSON call object (fixture: bare-object)", () => {
    const r = parseToolCalls('Sure: {"name": "ReadFile", "arguments": {"path": "a.ts"}}', schema);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ name: "ReadFile", arguments: { path: "a.ts" } });
    expect(r.clean).toBe("Sure:");
    expect(r.errors).toEqual([]);
  });

  it("accepts parameters and args keys for bare JSON (fixture: bare-object-keys)", () => {
    const r = parseToolCalls('{"name": "ReadFile", "parameters": {"path": "a"}} {"name": "ReadFile", "args": {"path": "b"}}', schema);
    expect(r.calls.map((c) => c.arguments)).toEqual([{ path: "a" }, { path: "b" }]);
  });

  it("parses an array of bare JSON calls (fixture: bare-array)", () => {
    const r = parseToolCalls('[{"name": "ReadFile", "arguments": {"path": "a"}}, {"name": "RunTerminal", "arguments": {"command": "ls"}}]', schema);
    expect(r.calls.map((c) => c.name)).toEqual(["ReadFile", "RunTerminal"]);
  });

  it("parses a ```json fenced call (fixture: fenced-json)", () => {
    const r = parseToolCalls('```json\n{"name": "ReadFile", "arguments": {"path": "a.ts"}}\n```', schema);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.arguments).toEqual({ path: "a.ts" });
    expect(r.clean).toBe("");
  });

  it("parses Gemma tool tokens with <|\"|> strings and numbers (fixture: gemma-call)", () => {
    const r = parseToolCalls('<|tool_call>call:ReadFile{path:<|"|>a.ts<|"|>,start_line:3}<tool_call|>', schema);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ name: "ReadFile", arguments: { path: "a.ts", start_line: 3 } });
    expect(r.errors).toEqual([]);
  });

  it("keeps braces and colons inside Gemma string values (fixture: gemma-string-braces)", () => {
    const r = parseToolCalls('<|tool_call>call:RunTerminal{command:<|"|>echo {a:1}<|"|>}<tool_call|>', schema);
    expect(r.calls[0]?.arguments).toEqual({ command: "echo {a:1}" });
  });

  it("parses two tagged calls when the first argument contains a fence line", () => {
    const r = parseToolCalls(
      '<tool_call>{"name":"RunTerminal","arguments":{"command":"echo a\\n```\\necho b"}}</tool_call>\n<tool_call>{"name":"ReadFile","arguments":{"path":"b"}}</tool_call>',
      schema,
    );
    expect(r.calls.map((c) => c.name)).toEqual(["RunTerminal", "ReadFile"]);
    expect(r.errors).toEqual([]);
  });

  it("parses a tagged call after an unclosed fence marker", () => {
    const r = parseToolCalls('```\nnot closed\n<tool_call>{"name":"ReadFile","arguments":{"path":"a"}}</tool_call>', schema);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.arguments).toEqual({ path: "a" });
  });

  it("negative: prose JSON with an unknown name is not a call and not an error", () => {
    const r = parseToolCalls('Example: {"name": "Nope", "arguments": {}}', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toEqual([]);
  });

  it("negative: bare JSON with extra keys is plain text, not a call", () => {
    const r = parseToolCalls('{"name": "ReadFile", "arguments": {"path": "a"}, "id": 1}', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toEqual([]);
  });

  it("negative: call-like code in a python fence is ignored without error", () => {
    const r = parseToolCalls('```python\n{"name": "ReadFile", "arguments": {"path": "a"}}\n```', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toEqual([]);
  });

  it("negative: a backticked tag mention is not a call and not an error", () => {
    const r = parseToolCalls("wrap calls in `<tool_call>` tags", schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toEqual([]);
  });

  it("negative: unknown Gemma tool name yields TC-UNKNOWN-TOOL", () => {
    const r = parseToolCalls('<|tool_call>call:Nope{x:<|"|>1<|"|>}<tool_call|>', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toEqual([expect.objectContaining({ code: "TC-UNKNOWN-TOOL" })]);
  });

  it("negative: Gemma block without call: prefix yields TC-GEMMA-NO-CALL", () => {
    const r = parseToolCalls("<|tool_call>ReadFile{}<tool_call|>", schema);
    expect(r.errors[0]?.code).toBe("TC-GEMMA-NO-CALL");
  });

  it("negative: unterminated Gemma string yields TC-GEMMA-INVALID", () => {
    const r = parseToolCalls('<|tool_call>call:ReadFile{path:<|"|>a.ts}<tool_call|>', schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors[0]?.code).toBe("TC-GEMMA-INVALID");
  });

  it("negative: unknown tag tool name is reported and kept as text", () => {
    const r = parseToolCalls('<tool_call>{"name":"Nope","arguments":{}}</tool_call>', schema);
    expect(r.errors).toEqual([{ code: "TC-UNKNOWN-TOOL", message: "unknown tool 'Nope'" }]);
    expect(r.clean).toContain("Nope");
  });

  it("negative: malformed tagged JSON is reported with its failure code", () => {
    const r = parseToolCalls('<tool_call>{"name":"ReadFile","arguments":{{{{</tool_call>', schema);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/malformed tool call/);
  });

  it("keeps a valid call and reports the failing one in the same text", () => {
    const r = parseToolCalls(
      '<tool_call>{"name":"Nope","arguments":{}}</tool_call><tool_call>{"name":"ReadFile","arguments":{"path":"a"}}</tool_call>',
      schema,
    );
    expect(r.calls.map((c) => c.name)).toEqual(["ReadFile"]);
    expect(r.errors).toHaveLength(1);
  });

  it("negative: unclosed tag that does not parse is text, not an error", () => {
    const r = parseToolCalls("use <tool_call> to call tools", schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toEqual([]);
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

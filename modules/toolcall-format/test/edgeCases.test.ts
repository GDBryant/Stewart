import { describe, expect, it } from "vitest";
import {
  parseToolCalls,
  repairNativeCall,
  shimExampleCall,
  ToolCallParseException,
  ToolCallStreamFilter,
  type SchemaMap,
} from "../src/api.js";
import type { ToolSpec } from "@stewart/kernel";

// All angle-bracket tool-call syntax is built dynamically.
const T = "tool" + "_call";
const OPEN = "<" + T + ">";
const CLOSE = "</" + T + ">";
const block = (body: string) => OPEN + body + CLOSE;
const lt = (s: string) => "<" + s + ">";
const ltEnd = (s: string) => "</" + s + ">";

const schema: SchemaMap = {
  ReadFile: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" } }, required: ["path"] },
  RunTerminal: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  Flag: { type: "object", properties: { on: { type: "boolean" }, n: { type: "number" } } },
};

describe("shimExampleCall", () => {
  it("samples boolean, array, object and unknown parameter types", () => {
    const spec: ToolSpec = {
      name: "Mix",
      description: "mixed types",
      parameters: {
        type: "object",
        properties: { b: { type: "boolean" }, a: { type: "array" }, o: { type: "object" }, s: {} },
        required: ["b", "a", "o", "s"],
      },
    };
    expect(shimExampleCall(spec)).toBe(OPEN + '{"name":"Mix","arguments":{"b":true,"a":[],"o":{},"s":"example"}}' + CLOSE);
  });

  it("handles a spec with no properties or required list", () => {
    const spec: ToolSpec = { name: "Ping", description: "no args", parameters: { type: "object" } };
    expect(shimExampleCall(spec)).toBe(OPEN + '{"name":"Ping","arguments":{}}' + CLOSE);
  });
});

describe("parseToolCalls edge cases", () => {
  it("rewrites attribute-form calls and strips channel markers", () => {
    const r = parseToolCalls(
      "x " + lt("|channel|") + "thought\n" + "<" + T + ' name="ReadFile" arguments=' + "'{\"path\":\"a.ts\"}'" + ">",
      schema,
    );
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("ReadFile");
    expect(r.calls[0].arguments).toEqual({ path: "a.ts" });
  });

  it("startInFence skips an unclosed leading fence", () => {
    const r = parseToolCalls('```json\n{"name":"ReadFile","arguments":{"path":"a"}}', schema, true);
    expect(r.calls).toHaveLength(0);
  });

  it("startInFence with a closed fence scans after it", () => {
    const r = parseToolCalls('```text\nstuff\n```\n' + block('{"name":"ReadFile","arguments":{"path":"a"}}'), schema, true);
    expect(r.calls).toHaveLength(1);
  });

  it("ignores calls inside a non-parsable fence", () => {
    const r = parseToolCalls("```python\n" + block('{"name":"ReadFile","arguments":{"path":"a"}}') + "\n```", schema);
    expect(r.calls).toHaveLength(0);
  });

  it("treats a backtick-quoted tag as a mention, not a call", () => {
    const r = parseToolCalls("use `" + block('{"name":"ReadFile","arguments":{"path":"a"}}') + "` like this", schema);
    expect(r.calls).toHaveLength(0);
    expect(r.clean).toContain(OPEN);
  });

  it("consumes an unclosed tag that parses to a known call", () => {
    const r = parseToolCalls("pre " + OPEN + '{"name":"ReadFile","arguments":{"path":"a"}}', schema);
    expect(r.calls).toHaveLength(1);
    expect(r.clean).toBe("pre");
  });

  it("leaves an unclosed tag that does not parse or names an unknown tool", () => {
    const r = parseToolCalls("pre " + OPEN + "not json at all", schema);
    expect(r.calls).toHaveLength(0);
    const u = parseToolCalls("pre " + OPEN + '{"name":"Nope","arguments":{}}', schema);
    expect(u.calls).toHaveLength(0);
  });

  it("reports an error for a closed but malformed block", () => {
    const r = parseToolCalls(block("total garbage"), schema);
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].code).toMatch(/^TC-/);
    expect(r.errors[0].message).toContain("malformed tool call");
  });

  it("treats bare non-call JSON as ordinary text", () => {
    expect(parseToolCalls("data []", schema).calls).toHaveLength(0);
    expect(parseToolCalls('data {"a":1}', schema).calls).toHaveLength(0);
    expect(parseToolCalls('data [{"a":1}]', schema).calls).toHaveLength(0);
  });

  it("parses a bare call-shaped array", () => {
    const r = parseToolCalls(
      '[{"name":"ReadFile","arguments":{"path":"a"}},{"name":"RunTerminal","arguments":{"command":"ls"}}]',
      schema,
    );
    expect(r.calls).toHaveLength(2);
  });

  it("collects reasoning from unclosed and multiple think blocks", () => {
    const think = lt("think");
    const thinkEnd = ltEnd("think");
    const r = parseToolCalls(think + "first" + thinkEnd + " mid " + think + "tail never closes", schema);
    expect(r.reasoning).toBe("first\ntail never closes");
    expect(r.clean).toBe("mid");
  });

  it("returns null reasoning when think blocks are empty", () => {
    const r = parseToolCalls(lt("think") + "   " + ltEnd("think") + "body", schema);
    expect(r.reasoning).toBeNull();
    expect(r.clean).toBe("body");
  });

  it("coerces boolean and number parameter values, leaves others raw", () => {
    const fn = lt("function=Flag");
    const p = (k: string, v: string) => lt("parameter=" + k) + v + ltEnd("parameter");
    const r = parseToolCalls(fn + p("on", "true") + p("n", "4") + ltEnd("function") + fn + p("on", "nope") + p("n", "x") + ltEnd("function"), schema);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].arguments).toEqual({ on: true, n: 4 });
    expect(r.calls[1].arguments).toEqual({ on: "nope", n: "x" });
  });

  it("trims one leading/trailing newline in parameter values", () => {
    const r = parseToolCalls(lt("function=ReadFile") + lt("parameter=path") + "\na.ts\n" + ltEnd("parameter") + ltEnd("function"), schema);
    expect(r.calls[0].arguments).toEqual({ path: "a.ts" });
  });

  it("maps exec aliases to RunTerminal only for a single command", () => {
    const one = parseToolCalls(block('{"name":"bash","arguments":{"command":"ls"}}'), schema);
    expect(one.calls[0].name).toBe("RunTerminal");
    expect(one.calls[0].arguments).toEqual({ command: "ls" });
    const many = parseToolCalls(block('{"name":"bash","arguments":{"commands":["ls","pwd"]}}'), schema);
    expect(many.errors).toHaveLength(1);
    const bad = parseToolCalls(block('{"name":"bash","arguments":{"commands":[]}}'), schema);
    expect(bad.errors).toHaveLength(1);
  });

  it("rewrites GLM blocks where arg_value appears without arg_key", () => {
    const r = parseToolCalls(
      block("ReadFile" + lt("arg_value") + "path" + ltEnd("arg_value") + lt("arg_key") + "start_line" + ltEnd("arg_key") + "2"),
      schema,
    );
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("ReadFile");
    expect(r.calls[0].arguments).toEqual({ path: "", start_line: 2 });
  });

  it("uses only the innermost nested opener", () => {
    const r = parseToolCalls(OPEN + block('{"name":"ReadFile","arguments":{"path":"a"}}'), schema);
    expect(r.calls).toHaveLength(1);
  });
});

describe("repairNativeCall edge cases", () => {
  it("repairs name-prefixed arguments without a name key", () => {
    const calls = repairNativeCall({ name: 'ReadFile {"path":"a"}', arguments: "{}" }, schema);
    expect(calls[0].name).toBe("ReadFile");
    expect(calls[0].arguments).toEqual({ path: "a" });
  });

  it("rejects when no object or tag is present", () => {
    expect(() => repairNativeCall({ name: "ReadFile", arguments: "plain text" }, schema)).toThrow(/TC-ARGS-INVALID/);
    expect(() => repairNativeCall({ name: "Nope", arguments: "plain text" }, schema)).toThrow(/TC-NATIVE-INVALID/);
  });
});

describe("ToolCallStreamFilter edge cases", () => {
  const run = (chunks: string[]) => {
    const f = new ToolCallStreamFilter();
    return { shown: chunks.map((c) => f.push(c)).join(""), held: f.flush() };
  };

  it("falls back to the literal closer for non-attribute opener forms", () => {
    expect(run(["a" + "<" + T + ' data-x="1">' + '{"name":"A"}' + CLOSE + "b"]).shown).toBe("ab");
  });

  it("drops stray call and function closers", () => {
    expect(run(["a" + ltEnd("call") + "b" + ltEnd("function") + "c"]).shown).toBe("abc");
  });
});

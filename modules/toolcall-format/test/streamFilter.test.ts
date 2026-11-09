import { describe, expect, it } from "vitest";
import { ToolCallStreamFilter } from "../src/api.js";

function run(chunks: string[]): { shown: string; held: string } {
  const f = new ToolCallStreamFilter();
  const shown = chunks.map((c) => f.push(c)).join("");
  return { shown, held: f.flush() };
}

describe("ToolCallStreamFilter", () => {
  it("hides a tool_call block in one chunk", () => {
    expect(run(['ok <tool_call>{"name":"A","arguments":{}}</tool_call> done']).shown).toBe("ok  done");
  });
  it("hides a block split at every character", () => {
    const text = 'hi <tool_call>{"name":"A","arguments":{"x":"<b>"}}</tool_call>bye';
    expect(run([...text]).shown).toBe("hi bye");
  });
  it("hides gemma, call, function and attribute forms", () => {
    expect(run(['a<|tool_call>call:X{}<tool_call|>b']).shown).toBe("ab");
    expect(run(['a<call>{}</call>b']).shown).toBe("ab");
    expect(run(['a<function=X><parameter=p>1</parameter></function>b']).shown).toBe("ab");
    expect(run([`a<tool_call name="X" arguments='{"p":1}'>b`]).shown).toBe("ab");
    expect(run([`a<tool_call name="X" arguments='{"p":1}'></tool_call>b`]).shown).toBe("ab");
  });
  it("hides <call name=... arguments=...> attribute blocks", () => {
    expect(run(['a<call name="X" arguments={"p":1}/>b']).shown).toBe("ab");
    expect(run(['a<call name="X" arguments={"p":1}></call>b']).shown).toBe("ab");
    expect(run([`a<call arguments='{"p":1}' name="X" />b`]).shown).toBe("ab");
  });
  it("hides an attribute block split at every character", () => {
    const text = 'hi <call name="X" arguments={"p":"<b>"} />bye';
    expect(run([...text]).shown).toBe("hi bye");
  });
  it("holds an unclosed <call attribute block for flush", () => {
    const r = run(['go <call name="X" arguments={"p":1}']);
    expect(r.shown).toBe("go ");
    expect(r.held).toBe('<call name="X" arguments={"p":1}');
  });
  it("drops stray closers", () => {
    expect(run(["a</tool_call>b"]).shown).toBe("ab");
  });
  it("passes plain text and lone angle brackets through", () => {
    expect(run(["x < y and <b>bold</b>"]).shown).toBe("x < y and <b>bold</b>");
    expect(run(["a <", "b"]).shown).toBe("a <b");
  });
  it("holds an unclosed block for flush instead of showing it", () => {
    const r = run(['go <tool_call>{"name":"A"']);
    expect(r.shown).toBe("go ");
    expect(r.held).toBe('<tool_call>{"name":"A"');
  });
  it("flushes a trailing partial opener", () => {
    const r = run(["end <tool_"]);
    expect(r.shown).toBe("end ");
    expect(r.held).toBe("<tool_");
  });
});

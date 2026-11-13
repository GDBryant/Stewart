import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@stewart/kernel";
import { forNative } from "../src/nativeMessages.js";

const t: ChatMessage[] = [
  { role: "user", content: "go" },
  { role: "assistant", content: "checking", toolCalls: [{ id: "c1", name: "ReadFile", arguments: { path: "a" } }] },
  { role: "tool", toolCallId: "c1", content: "file a" },
  { role: "assistant", content: "now writing", toolCalls: [{ id: "c2", name: "Bash", arguments: { command: "x" } }] },
  { role: "tool", toolCallId: "c2", content: "bash out ".repeat(80) },
  { role: "user", content: "thanks" },
];

describe("forNative", () => {
  const known = new Set(["ReadFile"]);

  it("flattens foreign tool calls and drops their tool messages", () => {
    const out = forNative(t, known);
    const flat = out[3];
    expect(flat.role).toBe("assistant");
    expect(flat.content).toContain("now writing");
    expect(flat.content).toContain('[Bash {"command":"x"}]');
    expect(out.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.toolCallId : ""))).toEqual(["c1"]);
  });

  it("leaves messages with only known calls untouched and does not mutate the transcript", () => {
    const copy = JSON.parse(JSON.stringify(t));
    const out = forNative(t, known);
    expect(out[1]).toBe(t[1]);
    expect(out[2]).toBe(t[2]);
    expect(t).toEqual(copy);
  });

  it("caps call args and results and keeps a mixed message as text", () => {
    const mixed: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [
        { id: "k", name: "ReadFile", arguments: { path: "b".repeat(300) } },
        { id: "f", name: "ForeignTool", arguments: { a: 1 } },
      ] },
      { role: "tool", toolCallId: "k", content: "known result" },
      { role: "tool", toolCallId: "f", content: "foreign result" },
    ];
    const out = forNative(mixed, known);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("[ForeignTool");
    expect(out[1]).toMatchObject({ role: "tool", toolCallId: "k" });
    const capped = forNative(t, known)[3].content;
    expect(capped.length).toBeLessThan(800);
  });

  it("no foreign calls: same messages, same order", () => {
    const out = forNative(t, new Set(["ReadFile", "Bash"]));
    expect(out).toEqual(t);
  });
});

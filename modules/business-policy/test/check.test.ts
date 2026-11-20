import type { ChatMessage } from "@stewart/kernel";
import { describe, expect, it } from "vitest";
import { applyOutbound, checkOutbound, describeViolation, registry, RULES, withheldMarker, type Rule } from "../src/api.js";

const SECRET = "password=hunter2";
const msgs = (...m: ChatMessage[]) => m;

describe("checkOutbound", () => {
  it("returns nothing for clean text or no rules", () => {
    expect(checkOutbound(msgs({ role: "user", content: "hello" }), ["passwords", "privacy"])).toEqual([]);
    expect(checkOutbound(msgs({ role: "user", content: SECRET }), [])).toEqual([]);
  });

  it("reports rule, role, index and a hint without the match", () => {
    const v = checkOutbound(msgs({ role: "system", content: "ok" }, { role: "user", content: `${SECRET} jane@example.com` }), ["passwords", "privacy"]);
    expect(v.map((x) => [x.rule, x.where, x.msgIndex])).toEqual([["passwords", "user", 1], ["privacy", "user", 1]]);
    expect(JSON.stringify(v)).not.toMatch(/hunter2|jane/);
  });

  it("only runs ticked rules", () => {
    expect(checkOutbound(msgs({ role: "user", content: "jane@example.com" }), ["passwords"])).toEqual([]);
  });

  it("scans assistant tool-call arguments", () => {
    const m: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "1", name: "write", arguments: { text: SECRET } }] };
    expect(checkOutbound([m], ["passwords"])[0]?.where).toBe("assistant");
  });

  it("describes a violation without text", () => {
    const [v] = checkOutbound(msgs({ role: "user", content: SECRET }), ["passwords"]);
    expect(describeViolation(v!)).toBe("passwords in user #0 (secret assignment)");
  });
});

describe("applyOutbound", () => {
  const tool: ChatMessage = { role: "tool", toolCallId: "t", content: `cat .env\n${SECRET}\njane@example.com` };

  it("withholds tool results in a copy and does not block", () => {
    const input = msgs({ role: "user", content: "hi" }, tool);
    const out = applyOutbound(input, ["passwords", "privacy"]);
    expect(out.blocked).toEqual([]);
    expect(out.withheld.map((v) => v.rule)).toEqual(["passwords", "privacy"]);
    expect(out.messages[1]).toEqual({ role: "tool", toolCallId: "t", content: "[output withheld by business policy: passwords, privacy]" });
    expect(input[1]).toBe(tool);
    expect(out.messages[0]).toBe(input[0]);
  });

  it("blocks user content and leaves clean tool results alone", () => {
    const clean: ChatMessage = { role: "tool", toolCallId: "t", content: "fine" };
    const out = applyOutbound(msgs({ role: "user", content: SECRET }, clean), ["passwords"]);
    expect(out.blocked).toHaveLength(1);
    expect(out.withheld).toEqual([]);
    expect(out.messages[1]).toBe(clean);
  });

  it("marker names each rule once", () => {
    expect(withheldMarker(["privacy", "privacy"])).toBe("[output withheld by business policy: privacy]");
  });
});

describe("registry", () => {
  it("has both v1 rules with descriptions", () => {
    expect(Object.keys(RULES).sort()).toEqual(["passwords", "privacy"]);
    expect(RULES.passwords.describe).not.toBe("");
  });
  it("rejects duplicate ids", () => {
    const r: Rule = { id: "passwords", describe: "", scan: () => [] };
    expect(() => registry([r, r])).toThrow(/duplicate/);
  });
});

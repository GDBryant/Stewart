import { describe, expect, it } from "vitest";
import { expandMentions } from "../src/api.js";
import { fakeHost } from "@stewart/kernel";

describe("expandMentions", () => {
  it("expands @file with bounded content", async () => {
    const { host } = fakeHost({ "src/a.ts": "export const a = 1;" });
    const r = await expandMentions(host, "look at @file:src/a.ts please");
    expect(r.text).toContain('@file:src/a.ts');
    expect(r.text).toContain('<file path="src/a.ts">\nexport const a = 1;\n</file>');
    expect(r.expanded).toEqual(["@file:src/a.ts"]);
    expect(r.dropped).toEqual([]);
  });

  it("drops an unreadable @file", async () => {
    const { host } = fakeHost();
    const r = await expandMentions(host, "see @file:missing.ts");
    expect(r.dropped).toEqual(["@file:missing.ts"]);
    expect(r.text).toBe("see @file:missing.ts");
  });

  it("truncates large files at the cap", async () => {
    const { host } = fakeHost({ "big.ts": "x".repeat(9000) });
    const r = await expandMentions(host, "@file:big.ts");
    expect(r.text).toContain("[truncated]");
  });

  it("expands @selection with path and lines", async () => {
    const { host, setSelection } = fakeHost();
    setSelection({ path: "src/a.ts", text: "const x = 1;", startLine: 3, endLine: 3 });
    const r = await expandMentions(host, "check @selection");
    expect(r.text).toContain('<selection path="src/a.ts" lines="3-3">\nconst x = 1;\n</selection>');
    expect(r.expanded).toEqual(["@selection"]);
  });

  it("drops @selection when nothing is selected", async () => {
    const { host } = fakeHost();
    const r = await expandMentions(host, "check @selection");
    expect(r.dropped).toEqual(["@selection"]);
  });

  it("expands @problems from diagnostics, capped at 50", async () => {
    const { host, setProblems } = fakeHost();
    setProblems(Array.from({ length: 60 }, (_, i) => ({ path: "a.ts", line: i + 1, message: `m${i}`, severity: "Error" })));
    const r = await expandMentions(host, "fix @problems");
    expect(r.text).toContain("a.ts:1 [Error] m0");
    expect(r.text).toContain("[+10 more]");
    expect(r.expanded).toEqual(["@problems"]);
  });

  it("drops @problems when there are none", async () => {
    const { host } = fakeHost();
    const r = await expandMentions(host, "fix @problems");
    expect(r.dropped).toEqual(["@problems"]);
  });

  it("deduplicates repeated mentions and leaves text without mentions untouched", async () => {
    const { host } = fakeHost({ "a.ts": "1" });
    const r = await expandMentions(host, "@file:a.ts and @file:a.ts");
    expect(r.expanded).toEqual(["@file:a.ts"]);
    expect(r.text.match(/<file path=/g)).toHaveLength(1);
    const plain = await expandMentions(host, "no mentions here");
    expect(plain.text).toBe("no mentions here");
  });
});

import { describe, expect, it } from "vitest";
import { expandMentions } from "../src/mentions.js";
import { importV1Xml, parseMiniXml } from "../src/v1import.js";
import { fakeHost } from "./helpers.js";

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

const V1_XML = `<application>
  <component name="StewartSettings">
    <option name="ollamaUrl" value="http://box:11434" />
    <option name="aifBaseUrl" value="https://aif.internal/v1" />
    <option name="aifModels"><list><option value="gpt-4o" /><option value="qwen" /></list></option>
    <option name="chatModel" value="ollama/llama3" />
    <option name="plannerModel" value="aif/gpt-4o" />
    <option name="workerModel" value="claude/sonnet-4-5" />
    <option name="effort" value="HIGH" />
    <option name="ollamaNumCtx"><map><entry key="ollama/llama3" value="32768" /></map></option>
    <option name="visionModelOverrides"><list><option value="ollama/llama3" /></list></option>
    <option name="historyRetentionDays" value="14" />
    <option name="debugLogEnabled" value="true" />
    <option name="autoApproveEdits" value="true" />
  </component>
</application>`;

describe("importV1Xml", () => {
  it("maps v1 options to channels, agents, roles and settings", () => {
    const r = importV1Xml(V1_XML, parseMiniXml);
    expect(Object.keys(r.files).sort()).toEqual(["agents.yaml", "channels.yaml", "roles.yaml", "settings.yaml"]);
    expect(r.files["channels.yaml"]).toContain("baseUrl: http://box:11434");
    expect(r.files["channels.yaml"]).toContain("id: aif");
    expect(r.files["channels.yaml"]).toContain("gpt-4o");
    expect(r.files["channels.yaml"]).toContain("numCtx: 32768");
    expect(r.files["channels.yaml"]).toContain("vision: true");
    expect(r.files["agents.yaml"]).toContain("effort: high");
    expect(r.files["agents.yaml"]).toContain("model: llama3");
    expect(r.files["roles.yaml"]).toContain("id: planner");
    expect(r.files["roles.yaml"]).toContain("id: general-worker");
    expect(r.files["settings.yaml"]).toContain("historyRetentionDays: 14");
    expect(r.files["settings.yaml"]).toContain("level: calls");
    expect(r.warnings.some((w) => w.includes("autoApproveEdits"))).toBe(true);
  });

  it("warns when no models are found", () => {
    const xml = `<application><component name="StewartSettings"><option name="ollamaUrl" value="http://x" /></component></application>`;
    const r = importV1Xml(xml, parseMiniXml);
    expect(r.files["channels.yaml"]).toBeTruthy();
    expect(r.files["agents.yaml"]).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("no v1 models"))).toBe(true);
  });

  it("skips unknown providers with a warning", () => {
    const xml = `<application><component name="StewartSettings"><option name="chatModel" value="gemini/pro" /></component></application>`;
    const r = importV1Xml(xml, parseMiniXml);
    expect(r.warnings.some((w) => w.includes("gemini"))).toBe(true);
    expect(r.files["agents.yaml"]).toBeUndefined();
  });

  it("reports non-stewart xml and unparseable xml", () => {
    expect(importV1Xml("<root/>", parseMiniXml).warnings[0]).toContain("no StewartSettings");
    expect(importV1Xml("<a><b></a>", parseMiniXml).warnings[0]).toContain("could not parse");
  });
});

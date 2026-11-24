import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mergeEscalationIntoSettings } from "../src/settingsEscalation.js";

const base = "version: 1\nrunTurnLimit: 9\nescalation:\n  onLoopGuard:\n    agent: a1\n    effort: max\n";
const out = (b: string | undefined, e: Parameters<typeof mergeEscalationIntoSettings>[1]) => {
  const f = mergeEscalationIntoSettings(b, e, { "agents.yaml": "x" });
  return { files: f, doc: f["settings.yaml"] ? (parse(f["settings.yaml"]) as Record<string, unknown>) : undefined };
};

describe("mergeEscalationIntoSettings", () => {
  it("is a no-op without an escalation patch", () => {
    expect(out(base, undefined).files).toEqual({ "agents.yaml": "x" });
  });
  it("pins an agent and replaces the saved block wholesale", () => {
    expect(out(base, { onLoopGuard: { agent: "a2" } }).doc).toMatchObject({ runTurnLimit: 9, escalation: { onLoopGuard: { agent: "a2" } } });
    expect((out(base, { onLoopGuard: { agent: "a2" } }).doc as any).escalation.onLoopGuard.effort).toBeUndefined();
  });
  it("Off writes enabled:false", () => {
    expect((out(base, { onLoopGuard: { enabled: false } }).doc as any).escalation.onLoopGuard).toEqual({ enabled: false });
  });
  it("Auto ({}) clears a saved pin but keeps other keys", () => {
    const d = out(base, { onLoopGuard: {} }).doc as any;
    expect(d.escalation).toBeUndefined();
    expect(d.runTurnLimit).toBe(9);
  });
  it("Auto with nothing saved writes nothing", () => {
    expect(out(undefined, { onLoopGuard: {} }).files).toEqual({ "agents.yaml": "x" });
    expect(out("version: 1\n", { onLoopGuard: {} }).files).toEqual({ "agents.yaml": "x" });
  });
});

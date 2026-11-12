import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { runCheck, turnCheck, type CheckInput } from "../src/api.js";

const baseInput = (over: Partial<CheckInput> = {}): CheckInput => ({ reply: "done", writes: [], changed: [], ...over });

describe("turnCheck", () => {
  it("uses the changed paths as required files", () => {
    expect(turnCheck(baseInput({ changed: ["a.ts", "b.ts"] }))).toEqual({ files: ["a.ts", "b.ts"] });
  });
  it("yields no files when nothing changed", () => {
    expect(turnCheck(baseInput())).toEqual({ files: [] });
  });
});

describe("runCheck writes rule", () => {
  it("fails a write whose last record is a failure", async () => {
    const { host } = fakeHost();
    const input = baseInput({ writes: [{ path: "a.ts", ok: false, message: "no match" }] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("write to a.ts failed: no match");
  });
  it("uses 'unknown' when the failure carries no message", async () => {
    const { host } = fakeHost();
    const input = baseInput({ writes: [{ path: "a.ts", ok: false }] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.evidence).toContain("write to a.ts failed: unknown");
  });
  it("passes a write that failed then succeeded", async () => {
    const { host } = fakeHost({ "a.ts": "x" });
    const input = baseInput({
      writes: [
        { path: "a.ts", ok: false, message: "no match" },
        { path: "a.ts", ok: true },
      ],
      changed: ["a.ts"],
    });
    const r = await runCheck({ check: turnCheck(input), input, host, cwd: "/p" });
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("changed: a.ts");
  });
});

describe("runCheck files rule", () => {
  it("fails when a required file is missing", async () => {
    const { host } = fakeHost();
    const r = await runCheck({ check: { files: ["nope.ts"] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("missing: nope.ts");
  });
  it("passes and lists changed files that read back", async () => {
    const { host } = fakeHost({ "src/a.ts": "content" });
    const r = await runCheck({ check: { files: ["src/a.ts"] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("changed: src/a.ts");
  });
});

describe("runCheck command rule", () => {
  it("passes on exit 0", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler((_argv, onData) => {
      onData("all good\n");
      return { code: 0 };
    });
    const r = await runCheck({ check: { command: ["pnpm", "test"] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("command ok: pnpm test");
  });
  it("fails on non-zero exit with output tail", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler((_argv, onData) => {
      onData("boom output");
      return { code: 3 };
    });
    const r = await runCheck({ check: { command: ["pnpm", "test"] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(r.evidence[0]).toMatch(/^pnpm test exited 3: boom output$/);
  });
  it("fails on timeout and kills the process", async () => {
    const { host, procs, setProcHandler } = fakeHost();
    setProcHandler(() => "never");
    const r = await runCheck({ check: { command: ["sleep", "99"] }, input: baseInput(), host, cwd: "/p", timeoutMs: 20 });
    expect(r.passed).toBe(false);
    expect(r.evidence[0]).toMatch(/timed out after 20ms/);
    expect(procs[0].killed).toBe(true);
  });
});

describe("runCheck reply rule", () => {
  it("fails an empty reply when nothing else happened", async () => {
    const { host } = fakeHost();
    const r = await runCheck({ check: {}, input: baseInput({ reply: "   " }), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("empty reply");
  });
  it("ignores the reply rule when writes happened", async () => {
    const { host } = fakeHost({ "a.ts": "x" });
    const input = baseInput({ reply: "", writes: [{ path: "a.ts", ok: true }], changed: ["a.ts"] });
    const r = await runCheck({ check: turnCheck(input), input, host, cwd: "/p" });
    expect(r.passed).toBe(true);
  });
});

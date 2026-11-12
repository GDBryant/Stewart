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

describe("runCheck cites rule", () => {
  const cited = async (files: Record<string, string>, reply: string) => {
    const { host } = fakeHost(files);
    return runCheck({ check: { cites: true }, input: baseInput({ reply }), host, cwd: "/p" });
  };
  it("passes when every cited path exists", async () => {
    const r = await cited({ "src/a.ts": "x", "lib/b.py": "y" }, "Found it in src/a.ts:12 and lib/b.py.");
    expect(r.passed).toBe(true);
    expect(r.evidence).toEqual(["cited: src/a.ts", "cited: lib/b.py"]);
  });
  it("fails when a cited path is missing", async () => {
    const r = await cited({ "src/a.ts": "x" }, "See src/a.ts and src/gone.ts.");
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("missing citation: src/gone.ts");
  });
  it("fails a findings-style reply with no citations", async () => {
    const r = await cited({}, "The function does three things wrong.");
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("no file citations in reply");
  });
  it("passes an empty-handed reply that says so", async () => {
    const r = await cited({}, "Could not find any matches for the symbol.");
    expect(r.passed).toBe(true);
  });
  it("ignores bare filenames without a directory", async () => {
    const r = await cited({}, "Nothing wrong. no matches found.");
    expect(r.passed).toBe(true);
  });
});

describe("runCheck health schema", () => {
  const health = async (files: Record<string, string>, reply: string) => {
    const { host } = fakeHost(files);
    return runCheck({ check: { schema: "health" }, input: baseInput({ reply }), host, cwd: "/p" });
  };
  const good = { files: [{ path: "src/a.ts", loc: 10, score: 8, band: "Yellow" }], findings: [{ path: "src/a.ts", line: 3, smell: "deep nesting", severity: "med", refactor: "extract" }], notChecked: ["src/x.ts"], checks: [] };
  it("passes a valid report", async () => {
    const r = await health({ "src/a.ts": "x" }, `Review done.\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("health: 1 files, 1 findings");
  });
  it("fails on invalid JSON", async () => {
    const r = await health({}, "```json\n{nope\n```");
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("health report: invalid JSON");
  });
  it("fails on the wrong shape", async () => {
    const r = await health({}, `\`\`\`json\n${JSON.stringify({ files: [{ path: 1 }] })}\n\`\`\``);
    expect(r.passed).toBe(false);
    expect(r.evidence[0]).toContain("health report: files[0]");
  });
  it("fails when a reported path is missing", async () => {
    const r = await health({}, `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("health report: missing file src/a.ts");
  });
  it("fails with zero or two json blocks", async () => {
    expect((await health({}, "no block")).evidence).toContain("health report: expected exactly one ```json block, found 0");
    const two = `\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    expect((await health({ "src/a.ts": "x" }, two)).evidence).toContain("health report: expected exactly one ```json block, found 2");
  });
});

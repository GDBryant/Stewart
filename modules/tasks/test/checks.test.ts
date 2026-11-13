import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { declaredCheck, isEditGoal, isReportGoal, runCheck, turnCheck, type CheckInput } from "../src/api.js";

const baseInput = (over: Partial<CheckInput> = {}): CheckInput => ({ reply: "done", writes: [], changed: [], ...over });

describe("turnCheck", () => {
  it("uses the changed paths as required files", () => {
    expect(turnCheck(baseInput({ changed: ["a.ts", "b.ts"] }))).toEqual({ files: ["a.ts", "b.ts"], changed: ["a.ts", "b.ts"] });
  });
  it("yields no files when nothing changed", () => {
    expect(turnCheck(baseInput())).toEqual({ files: [], changed: [] });
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
  const cited = async (files: Record<string, string>, reply: string, reads?: number) => {
    const { host } = fakeHost(files);
    return runCheck({ check: { cites: true }, input: baseInput({ reply, reads }), host, cwd: "/p" });
  };
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
  it("passes when every cited path exists", async () => {
    const r = await cited({ "src/a.ts": lines(20), "lib/b.py": "y" }, "Found it in src/a.ts:12 and lib/b.py.");
    expect(r.passed).toBe(true);
    expect(r.evidence).toEqual(["cited: src/a.ts:12", "cited: lib/b.py"]);
  });
  it("fails a citation whose line number is past the end of the file", async () => {
    const r = await cited({ "src/a.ts": lines(5) }, "Bug at src/a.ts:40.");
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("bad line citation: src/a.ts:40");
  });
  it("counts root-level files that exist and ignores bare tokens that are not files", async () => {
    const r = await cited({ "README.md": "x" }, "README.md is stale, e.g. version 3.0.0 is wrong.");
    expect(r.passed).toBe(true);
    expect(r.evidence).toEqual(["cited: README.md"]);
  });
  it("fails a 'no findings' reply when the turn read nothing", async () => {
    const r = await cited({}, "No issues found.", 0);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("no findings reported without reading any file");
    expect((await cited({}, "No issues found.", 2)).passed).toBe(true);
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

describe("content-changed check", () => {
  it("fails when the file equals its snapshot and passes when it differs", async () => {
    const { host } = fakeHost({ "a.ts": "same", "b.ts": "new" });
    const input = baseInput({ changed: ["a.ts", "b.ts"], before: { "a.ts": "same", "b.ts": "old" } });
    const r = await runCheck({ check: turnCheck(input), input, host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("unchanged: a.ts");
    expect(r.evidence).not.toContain("unchanged: b.ts");
  });
  it("treats a new file (before null) as changed and skips paths with no snapshot", async () => {
    const { host } = fakeHost({ "n.ts": "x", "u.ts": "x" });
    const input = baseInput({ changed: ["n.ts", "u.ts"], before: { "n.ts": null } });
    expect((await runCheck({ check: turnCheck(input), input, host, cwd: "/p" })).passed).toBe(true);
  });
});

describe("declaredCheck", () => {
  it("adds the declared command and files to the turn check", () => {
    const input = baseInput({ changed: ["a.ts"] });
    expect(declaredCheck(input, { command: ["npm", "test"], files: ["b.ts"] })).toMatchObject({ files: ["a.ts", "b.ts"], command: ["npm", "test"], changed: ["a.ts"] });
    expect(declaredCheck(input).command).toBeUndefined();
  });
});

describe("edit check", () => {
  const edit = async (over: Partial<CheckInput>, command?: string[], code = 0) => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler(() => ({ code }));
    return runCheck({ check: { edit: true, command }, input: baseInput(over), host, cwd: "/p" });
  };
  it("fails an edit request when no file changed", async () => {
    const r = await edit({});
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("edit request: no file changed");
  });
  it("passes when a write tool changed a file or the disk diff shows a change", async () => {
    const { host } = fakeHost({ "a.ts": "x" });
    const input = baseInput({ changed: ["a.ts"] });
    expect((await runCheck({ check: { edit: true, files: ["a.ts"] }, input, host, cwd: "/p" })).passed).toBe(true);
    expect((await edit({ diskChanged: ["b.ts"] })).passed).toBe(true);
  });
  it("passes with no change when a declared command passed, fails when it failed", async () => {
    expect((await edit({}, ["npm", "test"], 0)).passed).toBe(true);
    const bad = await edit({}, ["npm", "test"], 1);
    expect(bad.evidence).toContain("edit request: no file changed");
  });
});

describe("isEditGoal", () => {
  it("matches imperative change requests", () => {
    for (const g of ["Fix the failing test in src/a.test.ts", "please add a function sum", "Can you rename foo to bar?", "Implement M1", "  update the README"]) {
      expect(isEditGoal(g), g).toBe(true);
    }
  });
  it("does not match questions or explanations", () => {
    for (const g of ["How do I fix the failing test?", "Explain how to add a route", "What does update() do?", "List the src folder", "Summarise the diff", "write a summary"]) {
      expect(isEditGoal(g), g).toBe(false);
    }
  });
});

describe("isReportGoal", () => {
  it("matches review-style requests only", () => {
    expect(isReportGoal("Review the docs folder")).toBe(true);
    expect(isReportGoal("run a code health audit")).toBe(true);
    expect(isReportGoal("list the files in docs/")).toBe(false);
    expect(isReportGoal("summarise this diff")).toBe(false);
  });
});

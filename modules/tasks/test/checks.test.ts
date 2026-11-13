import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { declaredCheck, evidenceText, failureText, runCheck, type CheckInput, type CheckResult } from "../src/api.js";

const baseInput = (over: Partial<CheckInput> = {}): CheckInput => ({ reply: "done", writes: [], changed: [], ...over });
const details = (r: CheckResult) => evidenceText(r.evidence);
const code = (r: CheckResult, c: string) => r.evidence.find((e) => e.code === c);

describe("runCheck writes rule", () => {
  it("fails a write whose last record is a failure and the tracker reports no change", async () => {
    const { host } = fakeHost();
    const input = baseInput({ writes: [{ path: "a.ts", ok: false, message: "no match" }] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(code(r, "write_failed")?.detail).toBe("write to a.ts failed: no match");
  });
  it("uses 'unknown' when the failure carries no message", async () => {
    const { host } = fakeHost();
    const input = baseInput({ writes: [{ path: "a.ts", ok: false }] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(details(r)).toContain("write to a.ts failed: unknown");
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
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.passed).toBe(true);
  });
  it("forgives a failed write the tracker reports as changed anyway", async () => {
    const { host } = fakeHost({ "a.ts": "x" });
    const input = baseInput({ writes: [{ path: "a.ts", ok: false }], changed: ["a.ts"] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.passed).toBe(true);
  });
  it("fails a failed write when tracking is unavailable", async () => {
    const { host } = fakeHost({ "a.ts": "x" });
    const input = baseInput({ writes: [{ path: "a.ts", ok: false }], changed: undefined });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(code(r, "write_failed")?.ok).toBe(false);
  });
});

describe("runCheck files rule", () => {
  it("fails when a required file is missing", async () => {
    const { host } = fakeHost();
    const r = await runCheck({ check: { files: ["nope.ts"] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(code(r, "file_missing")?.detail).toBe("missing: nope.ts");
  });
  it("passes and lists declared files that read back", async () => {
    const { host } = fakeHost({ "src/a.ts": "content" });
    const r = await runCheck({ check: { files: ["src/a.ts"] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(true);
    expect(details(r)).toContain("changed: src/a.ts");
  });
  it("does not require changed or written files implicitly", async () => {
    const { host } = fakeHost();
    const input = baseInput({ changed: ["ghost.ts"], writes: [{ path: "ghost.ts", ok: true }] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
    expect(r.passed).toBe(true);
    expect(code(r, "file_missing")).toBeUndefined();
    expect(code(r, "file_present")).toBeUndefined();
  });
});

describe("runCheck command rule", () => {
  it("passes on exit 0", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler((_argv, onData) => {
      onData("all good\n");
      return { code: 0 };
    });
    const r = await runCheck({ check: { commands: [["pnpm", "test"]] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(true);
    expect(code(r, "command_ok")?.detail).toBe("command ok: pnpm test");
  });
  it("passes a command whose argv contains ' exited ' or ' timed out '", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler(() => ({ code: 0 }));
    for (const argv of [
      ["echo", "it exited 1 earlier"],
      ["echo", "it timed out before"],
    ]) {
      const r = await runCheck({ check: { commands: [argv] }, input: baseInput(), host, cwd: "/p" });
      expect(r.passed, argv.join(" ")).toBe(true);
      expect(code(r, "command_ok")?.ok).toBe(true);
    }
  });
  it("fails on non-zero exit with output tail", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler((_argv, onData) => {
      onData("boom output");
      return { code: 3 };
    });
    const r = await runCheck({ check: { commands: [["pnpm", "test"]] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(code(r, "command_failed")?.detail).toBe("pnpm test exited 3: boom output");
  });
  it("runs commands in order and stops at the first failure", async () => {
    const { host, procs, setProcHandler } = fakeHost();
    setProcHandler((argv) => (argv[0] === "fail" ? { code: 1 } : { code: 0 }));
    const r = await runCheck({ check: { commands: [["ok", "one"], ["fail", "two"], ["never", "three"]] }, input: baseInput(), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(r.evidence.map((e) => e.code)).toEqual(["command_ok", "command_failed"]);
    expect(procs.map((p) => p.argv[0])).toEqual(["ok", "fail"]);
  });
  it("mustChange fails on an empty diff, passes on changes, and is skipped when tracking is unavailable", async () => {
    const { host } = fakeHost();
    const input = baseInput();
    expect((await runCheck({ check: { mustChange: true }, input: { ...input, changed: [] }, host, cwd: "/p" })).evidence).toContainEqual({ code: "no_change", ok: false, detail: "no file changed" });
    expect((await runCheck({ check: { mustChange: true }, input: { ...input, changed: ["a.ts"] }, host, cwd: "/p" })).passed).toBe(true);
    expect((await runCheck({ check: { mustChange: true }, input: { ...input, changed: undefined }, host, cwd: "/p" })).passed).toBe(true);
  });
  it("fails on timeout and kills the process", async () => {
    const { host, procs, setProcHandler } = fakeHost();
    setProcHandler(() => "never");
    const r = await runCheck({ check: { commands: [["sleep", "99"]] }, input: baseInput(), host, cwd: "/p", timeoutMs: 20 });
    expect(r.passed).toBe(false);
    expect(code(r, "command_timeout")?.detail).toMatch(/timed out after 20ms/);
    expect(procs[0].killed).toBe(true);
  });
});

describe("runCheck reply rule", () => {
  it("fails an empty reply when nothing changed", async () => {
    const { host } = fakeHost();
    const r = await runCheck({ check: {}, input: baseInput({ reply: "   " }), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(code(r, "empty_reply")?.detail).toBe("empty reply");
  });
  it("fails an empty reply when tracking is unavailable", async () => {
    const { host } = fakeHost();
    const r = await runCheck({ check: {}, input: baseInput({ reply: "", changed: undefined }), host, cwd: "/p" });
    expect(r.passed).toBe(false);
    expect(code(r, "empty_reply")?.ok).toBe(false);
  });
  it("ignores the reply rule when files changed", async () => {
    const { host } = fakeHost({ "a.ts": "x" });
    const input = baseInput({ reply: "", writes: [{ path: "a.ts", ok: true }], changed: ["a.ts"] });
    const r = await runCheck({ check: {}, input, host, cwd: "/p" });
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
    expect(details(r)).toEqual(["cited: src/a.ts:12", "cited: lib/b.py"]);
  });
  it("fails a citation whose line number is past the end of the file", async () => {
    const r = await cited({ "src/a.ts": lines(5) }, "Bug at src/a.ts:40.");
    expect(r.passed).toBe(false);
    expect(code(r, "citation_bad_line")?.detail).toBe("bad line citation: src/a.ts:40");
  });
  it("fails a citation to a missing slash path", async () => {
    const r = await cited({}, "See src/nope.ts:1.");
    expect(r.passed).toBe(false);
    expect(code(r, "citation_missing")?.detail).toBe("missing citation: src/nope.ts");
  });
  it("counts root-level files that exist and ignores bare tokens that are not files", async () => {
    const r = await cited({ "README.md": "x" }, "README.md is stale, e.g. version 3.0.0 is wrong.");
    expect(r.passed).toBe(true);
    expect(details(r)).toEqual(["cited: README.md"]);
  });
  it("needs no minimum number of citations", async () => {
    const r = await cited({}, "No issues found.");
    expect(r.passed).toBe(true);
  });
});

describe("runCheck needsRead rule", () => {
  const nr = async (reads?: number) => {
    const { host } = fakeHost();
    return runCheck({ check: { needsRead: true }, input: baseInput({ reads }), host, cwd: "/p" });
  };
  it("fails when no file was read", async () => {
    for (const reads of [0, undefined]) {
      const r = await nr(reads);
      expect(r.passed).toBe(false);
      expect(code(r, "no_read")?.detail).toBe("no file was read");
    }
  });
  it("passes after one successful read", async () => {
    expect((await nr(1)).passed).toBe(true);
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
    expect(code(r, "health_ok")?.detail).toBe("health: 1 files, 1 findings");
  });
  it("fails on invalid JSON", async () => {
    const r = await health({}, "```json\n{nope\n```");
    expect(r.passed).toBe(false);
    expect(details(r)).toContain("health report: invalid JSON");
  });
  it("fails on the wrong shape", async () => {
    const r = await health({}, `\`\`\`json\n${JSON.stringify({ files: [{ path: 1 }] })}\n\`\`\``);
    expect(r.passed).toBe(false);
    expect(details(r)[0]).toContain("health report: files[0]");
  });
  it("fails when a reported path is missing", async () => {
    const r = await health({}, `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
    expect(r.passed).toBe(false);
    expect(details(r)).toContain("health report: missing file src/a.ts");
  });
  it("fails with zero or two json blocks", async () => {
    expect(details(await health({}, "no block"))).toContain("health report: expected exactly one ```json block, found 0");
    const two = `\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    expect(details(await health({ "src/a.ts": "x" }, two))).toContain("health report: expected exactly one ```json block, found 2");
  });
});

describe("declaredCheck", () => {
  it("maps the declared contract to files and command only", () => {
    expect(declaredCheck({ command: ["npm", "test"], files: ["b.ts"] })).toEqual({ files: ["b.ts"], commands: [["npm", "test"]] });
    expect(declaredCheck().commands).toBeUndefined();
    expect(declaredCheck().files).toEqual([]);
  });
});

describe("evidenceText and failureText", () => {
  it("evidenceText lists all details; failureText only the failing ones", async () => {
    const { host, setProcHandler } = fakeHost({ "a.ts": "x" });
    setProcHandler(() => ({ code: 1 }));
    const r = await runCheck({ check: { files: ["a.ts"], commands: [["npm", "test"]] }, input: baseInput(), host, cwd: "/p" });
    expect(details(r)).toEqual(["changed: a.ts", "npm test exited 1: "]);
    expect(failureText(r)).toBe("npm test exited 1: ");
  });
});

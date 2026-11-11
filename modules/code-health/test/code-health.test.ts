import { describe, expect, it } from "vitest";
import {
  aggregate, bandFor, batchInventory, isHealthCheckRequest, isSourceFile, mergeReports, renderReport,
} from "../src/api.js";
import type { FileHealth, HealthReport } from "../src/api.js";

const fh = (path: string, loc: number, score: number): FileHealth => ({ path, loc, score, band: bandFor(score) });

describe("bandFor", () => {
  it("bands at the documented thresholds", () => {
    expect(bandFor(9.5)).toBe("Green");
    expect(bandFor(9.4)).toBe("Yellow");
    expect(bandFor(7.0)).toBe("Yellow");
    expect(bandFor(6.9)).toBe("Red");
  });
});

describe("batchInventory", () => {
  it("splits on the file-count limit", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, loc: 10 }));
    const batches = batchInventory(files);
    expect(batches.map((b) => b.length)).toEqual([8, 2]);
  });

  it("splits on the LOC limit and isolates an over-limit file", () => {
    const files = [
      { path: "a.ts", loc: 2000 },
      { path: "big.ts", loc: 5000 },
      { path: "b.ts", loc: 1200 },
      { path: "c.ts", loc: 1500 },
    ];
    const batches = batchInventory(files);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([["a.ts"], ["big.ts"], ["b.ts", "c.ts"]]);
    expect(batches.every((b) => b.length === 1 || b.reduce((s, f) => s + f.loc, 0) <= 3000)).toBe(true);
  });

  it("returns no batches for an empty inventory", () => {
    expect(batchInventory([])).toEqual([]);
  });
});

describe("mergeReports", () => {
  it("dedupes files by path, last wins", () => {
    const a: HealthReport = { files: [fh("a.ts", 10, 5)], findings: [], notChecked: [] };
    const b: HealthReport = { files: [fh("a.ts", 10, 9), fh("b.ts", 20, 8)], findings: [], notChecked: ["c.ts"] };
    const m = mergeReports([a, b]);
    expect(m.files).toHaveLength(2);
    expect(m.files.find((f) => f.path === "a.ts")!.score).toBe(9);
    expect(m.notChecked).toEqual(["c.ts"]);
  });
});

describe("mergeReports checks", () => {
  it("concatenates checks deduped by name+command, last wins, and always returns checks", () => {
    const a: HealthReport = { files: [], findings: [], notChecked: [], checks: [{ name: "unit", command: "npm test", status: "pass", detail: "10 ok" }] };
    const b: HealthReport = { files: [], findings: [], notChecked: [], checks: [
      { name: "unit", command: "npm test", status: "fail", detail: "9/10" },
      { name: "e2e", command: "npm run e2e", status: "not run", detail: "denied" },
    ] };
    const m = mergeReports([a, b]);
    expect(m.checks).toEqual([
      { name: "unit", command: "npm test", status: "fail", detail: "9/10" },
      { name: "e2e", command: "npm run e2e", status: "not run", detail: "denied" },
    ]);
    expect(mergeReports([{ files: [], findings: [], notChecked: [] }])).toMatchObject({ checks: [] });
  });
});

describe("aggregate", () => {
  it("computes the LOC-weighted mean rounded to 0.1", () => {
    const a = aggregate({ files: [fh("a.ts", 100, 10), fh("b.ts", 900, 5)], findings: [], notChecked: [] });
    expect(a.score).toBe(5.5);
    expect(a.band).toBe("Red");
    expect(a.files).toBe(2);
    expect(a.loc).toBe(1000);
    expect(a.worst!.path).toBe("b.ts");
  });

  it("handles an empty report without throwing", () => {
    const a = aggregate({ files: [], findings: [], notChecked: [] });
    expect(a.score).toBe(0);
    expect(a.files).toBe(0);
    expect(a.worst).toBeUndefined();
  });

  it("counts findings by smell and lists red files", () => {
    const a = aggregate({
      files: [fh("a.ts", 10, 10), fh("b.ts", 10, 3)],
      findings: [
        { path: "b.ts", line: 1, smell: "long-function", severity: "high", refactor: "split" },
        { path: "b.ts", line: 9, smell: "long-function", severity: "low", refactor: "split" },
        { path: "a.ts", smell: "dead-code", severity: "med", refactor: "remove" },
      ],
      notChecked: [],
    });
    expect(a.red.map((f) => f.path)).toEqual(["b.ts"]);
    expect(a.bySmell).toEqual({ "long-function": 2, "dead-code": 1 });
  });
});

describe("renderReport", () => {
  const report: HealthReport = {
    files: [fh("src/small.ts", 100, 10), fh("src/big.ts", 900, 5)],
    findings: [
      { path: "src/big.ts", line: 9, smell: "dup", severity: "low", refactor: "extract" },
      { path: "src/big.ts", line: 3, smell: "god-class", severity: "high", refactor: "split" },
    ],
    notChecked: ["src/huge.ts"],
  };

  it("renders scope, overall, red files and LOC-desc per-file lines", () => {
    const out = renderReport(aggregate(report), report, "score");
    const lines = out.split("\n");
    expect(lines[0]).toBe("Scope: project · Mode: score · Checked: 2 files / 1000 LOC · Not checked: 1");
    expect(lines[1]).toBe("Overall: 5.5/10 (Red)");
    expect(out).toContain("Red files:");
    expect(out.indexOf("src/big.ts\t900")).toBeLessThan(out.indexOf("src/small.ts\t100"));
    expect(out).not.toContain("Findings:");
    expect(out).toContain("- src/huge.ts");
  });

  it("orders findings high→low in issues mode", () => {
    const out = renderReport(aggregate(report), report, "issues");
    expect(out).toContain("src/big.ts:3\tgod-class | high | split");
    expect(out.indexOf("high | split")).toBeLessThan(out.indexOf("low | extract"));
  });

  it("places the measured line right after Overall and renders the checks section", () => {
    const r: HealthReport = {
      ...report,
      checks: [{ name: "unit", command: "npm test", status: "pass", detail: "42/42" }],
    };
    const out = renderReport(aggregate(r), r, "score", "Measured (lexical scan, approximate): 2 files / 1000 LOC");
    const lines = out.split("\n");
    expect(lines[1]).toBe("Overall: 5.5/10 (Red)");
    expect(lines[2]).toBe("Measured (lexical scan, approximate): 2 files / 1000 LOC");
    expect(lines[3]).toBe("Project checks:");
    expect(lines[4]).toBe("- unit: pass — `npm test` — 42/42");
  });

  it("omits measured and checks sections when absent", () => {
    const out = renderReport(aggregate(report), report, "score");
    expect(out.split("\n")[2]).not.toContain("Measured");
    expect(out).not.toContain("Project checks:");
  });

  it("handles a checks-only report (no files)", () => {
    const r: HealthReport = {
      files: [], findings: [], notChecked: [],
      checks: [{ name: "pytest", command: "pytest -q", status: "fail", detail: "2 failed" }],
    };
    const out = renderReport(aggregate(r), r, "score");
    expect(out).toContain("Overall: 0/10 (Red)");
    expect(out).toContain("- pytest: fail — `pytest -q` — 2 failed");
  });
});

describe("isHealthCheckRequest", () => {
  it("matches project-scoped health requests", () => {
    expect(isHealthCheckRequest("check the health of this project")).toBe(true);
    expect(isHealthCheckRequest("code health score for the repo")).toBe(true);
    expect(isHealthCheckRequest("how healthy is the codebase")).toBe(true);
    expect(isHealthCheckRequest("check the health of the code in the folder: modules/kernel/ and give me a score")).toBe(true);
    expect(isHealthCheckRequest("health of the kernel module")).toBe(true);
    expect(isHealthCheckRequest("health of these files")).toBe(true);
  });

  it("rejects health-adjacent requests without a project scope", () => {
    expect(isHealthCheckRequest("is the server healthy")).toBe(false);
    expect(isHealthCheckRequest("health endpoint test")).toBe(false);
    expect(isHealthCheckRequest("compare phase 1 and phase 2 docs")).toBe(false);
  });
});

describe("isSourceFile", () => {
  it("accepts source extensions", () => {
    for (const p of ["a.ts", "a.tsx", "a.js", "a.kt", "a.java", "a.py", "a.go", "a.rs", "a.mjs", "a.cjs"]) {
      expect(isSourceFile(p), p).toBe(true);
    }
  });

  it("rejects excluded dirs, generated files and tests by default", () => {
    for (const p of ["dist/a.ts", "x/node_modules/a.ts", "a.d.ts", "a.test.ts", "src/test/util.ts", ".hidden/a.ts", "a.min.js", "README.md", "Makefile"]) {
      expect(isSourceFile(p), p).toBe(false);
    }
  });

  it("accepts test files with includeTests", () => {
    expect(isSourceFile("a.test.ts", { includeTests: true })).toBe(true);
    expect(isSourceFile("src/test/util.ts", { includeTests: true })).toBe(true);
    expect(isSourceFile("dist/a.ts", { includeTests: true })).toBe(false);
  });

  it("tolerates ./-prefixed paths from host file listings", () => {
    expect(isSourceFile("./src/a.ts")).toBe(true);
    expect(isSourceFile("./dist/a.ts")).toBe(false);
  });
});

describe("mergeReports findings", () => {
  const f = (over: Partial<import("../src/api.js").Finding>): import("../src/api.js").Finding =>
    ({ path: "a.ts", smell: "long-fn", severity: "high", refactor: "split", ...over });

  it("dedupes findings with the same path, line, smell and severity, last wins", () => {
    const a: HealthReport = { files: [], findings: [f({ line: 3, refactor: "old" })], notChecked: [] };
    const b: HealthReport = { files: [], findings: [f({ line: 3, refactor: "new" })], notChecked: [] };
    const m = mergeReports([a, b]);
    expect(m.findings).toEqual([f({ line: 3, refactor: "new" })]);
  });

  it("keeps findings that differ in line, line presence, or severity", () => {
    const a: HealthReport = { files: [], findings: [f({ line: 3 }), f({}), f({ line: 3, severity: "low" })], notChecked: [] };
    expect(mergeReports([a]).findings).toHaveLength(3);
  });

  it("tolerates reports missing their optional arrays", () => {
    const m = mergeReports([{ files: undefined, findings: undefined, notChecked: undefined } as unknown as HealthReport]);
    expect(m).toEqual({ files: [], findings: [], notChecked: [], checks: [] });
  });
});

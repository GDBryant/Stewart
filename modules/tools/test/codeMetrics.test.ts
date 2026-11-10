import { describe, expect, it } from "vitest";
import { projectTools } from "../src/builtins.js";
import { ProjectPaths } from "../src/projectPaths.js";
import { fakeHost } from "@stewart/kernel";

async function setup(files: Record<string, string>) {
  const h = fakeHost(files);
  const paths = await ProjectPaths.forProject(h.host);
  const reg = projectTools(h.host, paths);
  return reg.find("CodeMetrics")!;
}

const sig = new AbortController().signal;
const SRC = {
  "src/a.ts": "export function f(a: number) {\n  if (a) return 1\n  return 0\n}",
  "src/b.py": "def g():\n    return 1\n",
  "src/README.md": "doc",
};

describe("CodeMetrics", () => {
  it("measures a files array with the summary line and per-file rows", async () => {
    const t = await setup(SRC);
    const out = (await t.execute({ files: ["src/a.ts", "src/b.py"] }, null, sig)) as string;
    const lines = out.split("\n");
    expect(lines[0]).toContain("Measured (lexical scan, approximate): 2 files / 6 LOC");
    expect(out).toContain("src/a.ts\tLOC 4\tfns 1\tmax branches 1");
    expect(out).toContain("src/b.py\tLOC 2\tfns 1");
    expect(out).not.toContain("README");
  });

  it("a string files argument fails schema validation", async () => {
    const { host } = fakeHost(SRC);
    const paths = await ProjectPaths.forProject(host);
    const reg = projectTools(host, paths);
    const res = reg.validate({ id: "1", name: "CodeMetrics", arguments: { files: "src/a.ts,src/b.py" } });
    expect(res).not.toBeNull();
    expect(res).toContain("files");
  });

  it("measures a folder via path and skips non-source files", async () => {
    const t = await setup(SRC);
    const out = (await t.execute({ path: "src" }, null, sig)) as string;
    expect(out).toContain("src/a.ts\tLOC 4");
    expect(out).toContain("src/b.py\tLOC 2");
    expect(out).not.toContain("README");
  });

  it("defaults to the project root", async () => {
    const t = await setup(SRC);
    const out = (await t.execute({}, null, sig)) as string;
    expect(out).toContain("src/a.ts\tLOC 4");
  });

  it("excludes dist and tests by default; include_tests adds test files", async () => {
    const t = await setup({ "src/a.ts": "x", "dist/b.ts": "x", "src/a.test.ts": "x", "test/u.ts": "x" });
    const out = (await t.execute({ path: "." }, null, sig)) as string;
    expect(out).toContain("src/a.ts\tLOC 1");
    expect(out).not.toContain("a.test.ts");
    expect(out).not.toContain("test/u.ts");
    expect(out).not.toContain("dist");
    const withTests = (await t.execute({ path: ".", include_tests: true }, null, sig)) as string;
    expect(withTests).toContain("src/a.test.ts");
    expect(withTests).toContain("test/u.ts");
    expect(withTests).not.toContain("dist");
  });

  it("marks oversize and binary files as not measured", async () => {
    const t = await setup({ "big.ts": "x".repeat(1_000_001), "bin.ts": "a\0b", "ok.ts": "x" });
    const out = (await t.execute({ files: ["big.ts", "bin.ts", "ok.ts"] }, null, sig)) as string;
    expect(out).toContain("big.ts\tLOC 0\tnot measured");
    expect(out).toContain("bin.ts\tLOC 0\tnot measured");
    expect(out).toContain("ok.ts\tLOC 1");
  });

  it("lists a missing explicit file as not found", async () => {
    const t = await setup(SRC);
    const out = (await t.execute({ files: ["nope.ts", "src/a.ts"] }, null, sig)) as string;
    expect(out).toContain("nope.ts\tnot found");
    expect(out).toContain("src/a.ts\tLOC 4");
  });

  it("marks a non-source explicit file as not measured", async () => {
    const t = await setup(SRC);
    const out = (await t.execute({ files: ["src/README.md"] }, null, sig)) as string;
    expect(out).toContain("src/README.md\tLOC 1\tnot measured");
  });

  it("throws 'no source files' when nothing resolves", async () => {
    const t = await setup(SRC);
    await expect(t.execute({ files: ["docs"] }, null, sig)).rejects.toThrow(/no source files/);
    await expect(t.execute({ path: "docs" }, null, sig)).rejects.toThrow(/no source files/);
  });

  it("rejects workspace escapes", async () => {
    const t = await setup(SRC);
    await expect(t.execute({ files: ["../out.ts"] }, null, sig)).rejects.toThrow(/escapes workspace/);
    await expect(t.execute({ path: "../out" }, null, sig)).rejects.toThrow(/escapes workspace/);
  });
});

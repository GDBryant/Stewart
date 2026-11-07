import { describe, expect, it } from "vitest";
import { projectTools } from "../src/tools/builtins.js";
import { ProjectPaths } from "../src/tools/projectPaths.js";
import { fakeHost } from "@stewart/kernel";

async function setup(files: Record<string, string>) {
  const h = fakeHost(files);
  const paths = await ProjectPaths.forProject(h.host);
  const reg = projectTools(h.host, paths);
  return { reg, files: h.files, procs: h.procs, setProcHandler: h.setProcHandler };
}

const sig = new AbortController().signal;

describe("ReadFile", () => {
  it("reads a file with line numbers and ranges", async () => {
    const { reg } = await setup({ "a.ts": "l1\nl2\nl3" });
    const t = reg.find("ReadFile")!;
    expect(await t.execute({ path: "a.ts" }, null, sig)).toBe("1: l1\n2: l2\n3: l3");
    expect(await t.execute({ path: "a.ts", start_line: 2, end_line: 3 }, null, sig)).toBe("2: l2\n3: l3");
  });

  it("rejects escapes, denied dirs, missing, binary and huge files", async () => {
    const { reg } = await setup({ "a.ts": "x", "b.bin": "a\0b", ".git/cfg": "x" });
    const t = reg.find("ReadFile")!;
    await expect(t.execute({ path: "../out" }, null, sig)).rejects.toThrow(/escapes/);
    await expect(t.execute({ path: ".git/cfg" }, null, sig)).rejects.toThrow(/denied/);
    await expect(t.execute({ path: "nope" }, null, sig)).rejects.toThrow(/not found/);
    await expect(t.execute({ path: "b.bin" }, null, sig)).rejects.toThrow(/binary/);
    await expect(t.execute({ path: "a.ts", start_line: 5 }, null, sig)).rejects.toThrow(/line range/);
  });
});

describe("FindFiles", () => {
  it("matches globs and reports overflow", async () => {
    const { reg } = await setup({ "src/a.ts": "", "src/b.ts": "", "src/x/c.ts": "", "README.md": "" });
    const t = reg.find("FindFiles")!;
    const out = await t.execute({ glob: "src/**" }, null, sig);
    expect(out.split("\n")).toHaveLength(3);
    expect(await t.execute({ glob: "*.md" }, null, sig)).toBe("README.md");
    expect(await t.execute({ glob: "*.py" }, null, sig)).toBe("no files matched");
    await expect(t.execute({ glob: "[" }, null, sig)).rejects.toThrow();
  });
});

describe("Search", () => {
  it("finds literal and regex matches with line numbers", async () => {
    const { reg } = await setup({ "a.ts": "foo\nbar", "b.ts": "foo2" });
    const t = reg.find("Search")!;
    expect(await t.execute({ query: "foo" }, null, sig)).toBe("a.ts:1: foo\nb.ts:1: foo2");
    expect(await t.execute({ query: "ba.", regex: true }, null, sig)).toBe("a.ts:2: bar");
    expect(await t.execute({ query: "zz" }, null, sig)).toBe("no matches");
    await expect(t.execute({ query: "(", regex: true }, null, sig)).rejects.toThrow(/invalid regex/);
  });

  it("skips binary files", async () => {
    const { reg } = await setup({ "b.bin": "x\0foo" });
    expect(await reg.find("Search")!.execute({ query: "foo" }, null, sig)).toBe("no matches");
  });
});

describe("WriteFile / EditFile", () => {
  it("writes a new file via preview+execute", async () => {
    const { reg, files } = await setup({});
    const t = reg.find("WriteFile")!;
    const preview = await t.preview!({ path: "n.ts", content: "hello" });
    expect(await t.execute({ path: "n.ts", content: "hello" }, preview, sig)).toMatch(/wrote n.ts/);
    expect(files["n.ts"]).toBe("hello");
  });

  it("rejects stale previews (file changed since preview)", async () => {
    const { reg, files } = await setup({ "a.ts": "v1" });
    const t = reg.find("WriteFile")!;
    const preview = await t.preview!({ path: "a.ts", content: "v2" });
    files["a.ts"] = "someone else";
    await expect(t.execute({ path: "a.ts", content: "v2" }, preview, sig)).rejects.toThrow(/changed since preview/);
  });

  it("edits text, requires unique anchor unless replace_all", async () => {
    const { reg, files } = await setup({ "a.ts": "x a x" });
    const t = reg.find("EditFile")!;
    await expect(t.preview!({ path: "a.ts", old_string: "x", new_string: "y" })).rejects.toThrow(/matches 2 times/);
    const p = await t.preview!({ path: "a.ts", old_string: "x", new_string: "y", replace_all: true });
    expect(await t.execute({ path: "a.ts", old_string: "x", new_string: "y", replace_all: true }, p, sig)).toBe("edited a.ts");
    expect(files["a.ts"]).toBe("y a y");
    await expect(t.preview!({ path: "a.ts", old_string: "zzz", new_string: "q" })).rejects.toThrow(/not found/);
    await expect(t.preview!({ path: "a.ts", old_string: "", new_string: "q" })).rejects.toThrow(/empty/);
  });
});

describe("RunTerminal", () => {
  it("runs a command and captures output + exit code", async () => {
    const { reg, setProcHandler } = await setup({});
    setProcHandler((_argv, onData) => {
      onData("out\n");
      return { code: 3 };
    });
    const t = reg.find("RunTerminal")!;
    const p = await t.preview!({ command: "make x" });
    expect(await t.execute({ command: "make x" }, p, sig)).toBe("exit code: 3\nout\n");
  });

  it("rejects a command changed since approval", async () => {
    const { reg } = await setup({});
    const t = reg.find("RunTerminal")!;
    const p = await t.preview!({ command: "ls" });
    await expect(t.execute({ command: "rm -rf ." }, p, sig)).rejects.toThrow(/changed since approval/);
  });

  it("kills the process tree on abort", async () => {
    const { reg, procs, setProcHandler } = await setup({});
    setProcHandler(() => "never");
    const t = reg.find("RunTerminal")!;
    const p = await t.preview!({ command: "sleep 99" });
    const ctl = new AbortController();
    const exec = t.execute({ command: "sleep 99" }, p, ctl.signal);
    ctl.abort();
    const out = await exec;
    expect(out).toContain("exit code: -1");
    expect(procs[0].killed).toBe(true);
  });
});

describe("ToolRegistry validation", () => {
  it("validates required args and types", async () => {
    const { reg } = await setup({});
    expect(reg.validate({ id: "1", name: "Nope", arguments: {} })).toMatch(/unknown tool/);
    expect(reg.validate({ id: "1", name: "ReadFile", arguments: {} })).toMatch(/missing required/);
    expect(reg.validate({ id: "1", name: "ReadFile", arguments: { path: 5 } })).toMatch(/expected type string/);
    expect(reg.validate({ id: "1", name: "ReadFile", arguments: { path: "a", bogus: 1 } })).toMatch(/unexpected argument/);
    expect(reg.validate({ id: "1", name: "ReadFile", arguments: { path: "a" } })).toBeNull();
  });
});

describe("ApplyPatch / GetProblems / GetDiff / ReadImage / GenerateImage", () => {
  it("applies a unified diff patch and rejects bad hunks", async () => {
    const { reg, files } = await setup({ "a.ts": "line1\nline2\nline3" });
    const t = reg.find("ApplyPatch")!;
    const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_mod\n line3";
    const p = await t.preview!({ path: "a.ts", patch });
    expect(await t.execute({ path: "a.ts", patch }, p, sig)).toBe("patched a.ts");
    expect(files["a.ts"]).toBe("line1\nline2_mod\nline3");
    await expect(t.preview!({ path: "a.ts", patch: "not a patch" })).rejects.toThrow(/no hunks/);
    await expect(t.preview!({ path: "a.ts", patch: "@@ -1,1 +1,1 @@\n-missing\n+new" })).rejects.toThrow(/failed to apply/);
  });

  it("lists diagnostics via GetProblems and git diff via GetDiff", async () => {
    const h = fakeHost({ "a.ts": "x" });
    h.host.diag.problems = async () => [{ path: "a.ts", line: 4, severity: "ERROR", message: "bad type" }];
    h.setProcHandler((_argv, onData) => {
      onData("diff --git a/a.ts b/a.ts\n+x\n");
      return { code: 0 };
    });
    const paths = await ProjectPaths.forProject(h.host);
    const reg = projectTools(h.host, paths);
    expect(await reg.find("GetProblems")!.execute({}, null, sig)).toBe("a.ts:4 [ERROR]: bad type");
    expect(await reg.find("GetDiff")!.execute({ path: "a.ts", staged: true }, null, sig)).toContain("diff --git");
  });

  it("reads and generates image assets", async () => {
    const { reg, files } = await setup({ "assets/logo.png": " b64:aGk=", "assets/logo.svg": "<svg/>" });
    const img = await reg.find("ReadImage")!.execute({ path: "assets/logo.png" }, null, sig);
    expect(img.text).toContain("image assets/logo.png");
    expect(img.images[0]).toMatch(/^data:image\/png;base64,/);
    await expect(reg.find("ReadImage")!.execute({ path: "assets/logo.svg" }, null, sig)).rejects.toThrow(/not an image/);
    await expect(reg.find("ReadImage")!.execute({ path: "assets/missing.png" }, null, sig)).rejects.toThrow(/not found/);
    const gen = reg.find("GenerateImage")!;
    const p = await gen.preview!({ path: "assets/new.svg", prompt: "flow diagram" });
    expect(p).toEqual({ kind: "other", category: "OTHER" });
    expect(await gen.execute({ path: "assets/new.svg", prompt: "flow diagram" }, p, sig)).toBe("generated assets/new.svg");
    expect(files["assets/new.svg"]).toContain("<svg");
  });

  it("allows .stewart/scratch while denying other .stewart files, and auto-approves scratch writes", async () => {
    const { reg, files } = await setup({});
    const w = reg.find("WriteFile")!;
    await expect(w.preview!({ path: ".stewart/roles.yaml", content: "x" })).rejects.toThrow(/denied/);
    const p = await w.preview!({ path: ".stewart/scratch/note.txt", content: "ok" });
    await w.execute({ path: ".stewart/scratch/note.txt", content: "ok" }, p, sig);
    expect(files[".stewart/scratch/note.txt"]).toBe("ok");
    const { Grants } = await import("@stewart/permissions");
    const g = new Grants();
    expect(g.isGranted("EDITS", p)).toBe(true);
    expect(g.audit[0]).toMatchObject({ decision: "auto", category: "EDITS", target: ".stewart/scratch/note.txt" });
  });

  it("registers external ToolProvider plugins under MCP:<server> categories", async () => {
    const { reg } = await setup({});
    const { categoryOf } = await import("@stewart/permissions");
    reg.registerProvider({
      id: "linear",
      tools: () => [
        {
          spec: { name: "linear_list", description: "list issues", parameters: { type: "object", properties: {} } },
          requiresApproval: true,
          execute: async () => "issues",
        },
      ],
    });
    const tool = reg.find("linear_list")!;
    expect(tool.category).toBe("MCP:linear");
    const preview = await tool.preview!({});
    expect(categoryOf(preview, tool)).toBe("MCP:linear");
    expect(await tool.execute({}, preview, sig)).toBe("issues");
  });
});

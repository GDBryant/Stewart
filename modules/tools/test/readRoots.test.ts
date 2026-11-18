import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeHost, type HostPort } from "@stewart/kernel";
import { projectTools } from "../src/builtins.js";
import { ProjectPaths } from "../src/projectPaths.js";

const sig = new AbortController().signal;
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "stewart-readroots-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await fsp.rm(dirs.pop()!, { recursive: true, force: true });
});

async function walk(absDir: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(absDir, { withFileTypes: true })) {
    const shown = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(absDir, e.name), shown)));
    else out.push(shown);
  }
  return out;
}

function realFiles(ws: string): HostPort["files"] {
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(ws, p));
  return {
    read: async (p) => ({ content: await fsp.readFile(abs(p), "utf8") }),
    readBack: async (p) => fsp.readFile(abs(p), "utf8"),
    exists: async (p) => fsp.stat(abs(p)).then(() => true, () => false),
    list: async (dir) => walk(abs(dir), dir === "." ? "" : dir),
    stat: async (p) => ({ size: (await fsp.stat(abs(p))).size }),
    readBinary: async (p) => {
      const b = await fsp.readFile(abs(p));
      return { base64: b.toString("base64"), size: b.byteLength };
    },
    writeBinary: async (p, b64) => void (await fsp.writeFile(abs(p), Buffer.from(b64, "base64"))),
    edit: async () => ({ applied: true as const }),
    writeAtomic: async (p, c) => void (await fsp.writeFile(abs(p), c)),
    appendLine: async () => {},
    readLines: async () => [],
    delete: async () => {},
  };
}

async function setup(readRoots: string[], files: Record<string, string>) {
  const ws = await tmp();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(ws, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
  const h = fakeHost({});
  h.host.workspace.roots = async () => [ws];
  h.host.files = realFiles(ws);
  const paths = await ProjectPaths.forProject(h.host, { readRoots });
  return { ws, reg: projectTools(h.host, paths) };
}

describe("readRoots external reads", () => {
  it("reads, lists and searches files under a configured read root", async () => {
    const ext = await tmp();
    const canon = await fsp.realpath(ext);
    await fsp.writeFile(path.join(ext, "ref.ts"), "alpha\nbeta\n");
    await fsp.writeFile(path.join(ext, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { reg } = await setup([ext], { "w.ts": "ws" });
    const file = `${canon}/ref.ts`;
    expect(await reg.find("ReadFile")!.execute({ path: file }, null, sig)).toBe("1: alpha\n2: beta");
    expect(await reg.find("FindFiles")!.execute({ glob: "*.ts", path: ext }, null, sig)).toBe(file);
    expect(await reg.find("Search")!.execute({ query: "beta", path: ext }, null, sig)).toBe(`${file}:2: beta`);
    expect(await reg.find("ListCodeFiles")!.execute({ path: ext }, null, sig)).toBe(`${file}\t2`);
    const img = (await reg.find("ReadImage")!.execute({ path: `${canon}/pic.png` }, null, sig)) as { images: string[] };
    expect(img.images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("denies unconfigured absolute reads with a capability hint", async () => {
    const ext = await tmp();
    await fsp.writeFile(path.join(ext, "x.ts"), "x");
    const { reg } = await setup([], {});
    await expect(reg.find("ReadFile")!.execute({ path: path.join(ext, "x.ts") }, null, sig)).rejects.toThrow(/readRoots capability.*\.stewart\/project\.yaml/);
  });

  it("denies traversal and symlink escapes outside the configured root", async () => {
    const ext = await tmp();
    const outside = await tmp();
    await fsp.writeFile(path.join(outside, "secret.txt"), "s");
    await fsp.writeFile(path.join(ext, "ok.ts"), "o");
    await fsp.symlink(path.join(outside, "secret.txt"), path.join(ext, "link.txt"));
    const { reg } = await setup([ext], {});
    const rf = reg.find("ReadFile")!;
    await expect(rf.execute({ path: `${ext}/../${path.basename(outside)}/secret.txt` }, null, sig)).rejects.toThrow(/readRoots/);
    await expect(rf.execute({ path: `${ext}/link.txt` }, null, sig)).rejects.toThrow(/readRoots/);
    await expect(rf.execute({ path: `${ext}/missing.ts` }, null, sig)).rejects.toThrow(/not found/);
    expect(await rf.execute({ path: `${ext}/ok.ts` }, null, sig)).toBe("1: o");
  });

  it("does not trust a configured read root that cannot canonicalize", async () => {
    const ext = await tmp();
    await fsp.writeFile(path.join(ext, "x.ts"), "x");
    const { reg } = await setup([path.join(ext, "missing")], {});
    await expect(reg.find("ReadFile")!.execute({ path: path.join(ext, "x.ts") }, null, sig)).rejects.toThrow(/readRoots/);
  });

  it("keeps writes, CodeMetrics and RunTerminal cwd workspace-only", async () => {
    const ext = await tmp();
    const { reg } = await setup([ext], { "a.ts": "x" });
    await expect(reg.find("WriteFile")!.preview!({ path: path.join(ext, "x.ts"), content: "y" })).rejects.toThrow(/escapes/);
    await expect(reg.find("EditFile")!.preview!({ path: path.join(ext, "x.ts"), old_string: "x", new_string: "y" })).rejects.toThrow(/escapes/);
    await expect(reg.find("RunTerminal")!.preview!({ command: "ls", cwd: ext })).rejects.toThrow(/escapes/);
    await expect(reg.find("CodeMetrics")!.execute({ path: ext }, null, sig)).rejects.toThrow(/escapes/);
  });

  it("leaves ordinary workspace paths unchanged", async () => {
    const ext = await tmp();
    const { reg } = await setup([ext], { "src/a.ts": "l1\nl2\n" });
    expect(await reg.find("ReadFile")!.execute({ path: "src/a.ts" }, null, sig)).toBe("1: l1\n2: l2");
    await expect(reg.find("ReadFile")!.execute({ path: "../a.ts" }, null, sig)).rejects.toThrow(/escapes/);
    expect(await reg.find("FindFiles")!.execute({ glob: "**/*.ts" }, null, sig)).toBe("src/a.ts");
  });
});

import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import type { HostPort } from "@stewart/kernel";
import { ProjectPaths } from "../src/projectPaths.js";
import { WriteFile, EditFile } from "../src/fsWrite.js";
import { projectTools } from "../src/builtins.js";

const sig = new AbortController().signal;

async function setup(files: Record<string, string>) {
  const h = fakeHost(files);
  const paths = await ProjectPaths.forProject(h.host);
  return { h, paths, reg: projectTools(h.host, paths) };
}

class FastWrite extends WriteFile {
  protected override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

class FastEdit extends EditFile {
  protected override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** Host whose readBack replays `seq` (undefined = throw), then repeats the last entry. */
function flakyHost(files: Record<string, string>, seq: (string | undefined)[]): HostPort {
  const h = fakeHost(files);
  let i = 0;
  const readBack = async (p: string) => {
    const v = seq[Math.min(i++, seq.length - 1)];
    if (v === undefined) throw new Error(`file not found: ${p}`);
    return v;
  };
  return { ...h.host, files: { ...h.host.files, readBack } };
}

describe("WriteFile new files", () => {
  it("writes a new file in a new dir through writeAtomic, never files.edit", async () => {
    const { h, reg } = await setup({});
    const t = reg.find("WriteFile")!;
    const preview = await t.preview!({ path: "new/dir/n.ts", content: "hello" });
    expect(await t.execute({ path: "new/dir/n.ts", content: "hello" }, preview, sig)).toMatch(/wrote new\/dir\/n\.ts/);
    expect(h.files["new/dir/n.ts"]).toBe("hello");
    expect(h.edits).toHaveLength(0);
  });

  it("writes an existing file through files.edit", async () => {
    const { h, reg } = await setup({ "a.ts": "v1" });
    const t = reg.find("WriteFile")!;
    const preview = await t.preview!({ path: "a.ts", content: "v2" });
    expect(await t.execute({ path: "a.ts", content: "v2" }, preview, sig)).toMatch(/wrote a\.ts/);
    expect(h.edits).toHaveLength(1);
    expect(h.files["a.ts"]).toBe("v2");
  });

  it("EditFile on a missing file still fails with the did-you-mean message", async () => {
    const { reg } = await setup({ "d/Meeting.php": "x" });
    await expect(reg.find("EditFile")!.preview!({ path: "d/XMeeting.php", old_string: "a", new_string: "b" })).rejects.toThrow(
      "file not found: d/XMeeting.php (did you mean d/Meeting.php?)",
    );
  });
});

describe("post-write verification", () => {
  it("accepts a transient stale read once disk catches up", async () => {
    const host = flakyHost({ "a.ts": "v1" }, ["v1", "v2"]);
    const paths = await ProjectPaths.forProject(host);
    const t = new FastEdit(host, paths);
    const p = await t.preview!({ path: "a.ts", old_string: "v1", new_string: "v2" });
    expect(await t.execute({ path: "a.ts", old_string: "v1", new_string: "v2" }, p, sig)).toBe("edited a.ts");
  });

  it("accepts whitespace-only differences and appends the note", async () => {
    const host = flakyHost({ "a.ts": "v1" }, ["v2 \n\n"]);
    const paths = await ProjectPaths.forProject(host);
    const t = new FastWrite(host, paths);
    const p = await t.preview!({ path: "a.ts", content: "v2" });
    expect(await t.execute({ path: "a.ts", content: "v2" }, p, sig)).toBe(
      "wrote a.ts (1 lines) (saved with whitespace changes by the editor; re-read before editing it again)",
    );
  });

  it("fails with 'write did not reach disk' when disk still equals before", async () => {
    const host = flakyHost({ "a.ts": "v1" }, ["v1"]);
    const paths = await ProjectPaths.forProject(host);
    const t = new FastWrite(host, paths);
    const p = await t.preview!({ path: "a.ts", content: "v2" });
    await expect(t.execute({ path: "a.ts", content: "v2" }, p, sig)).rejects.toThrow("write did not reach disk: a.ts");
  });

  it("keeps the differing-content error for a real mismatch", async () => {
    const host = flakyHost({ "a.ts": "v1" }, ["v3"]);
    const paths = await ProjectPaths.forProject(host);
    const t = new FastWrite(host, paths);
    const p = await t.preview!({ path: "a.ts", content: "v2" });
    await expect(t.execute({ path: "a.ts", content: "v2" }, p, sig)).rejects.toThrow(
      "file content differs from approved change; side effects uncertain: a.ts",
    );
  });

  it("keeps the file-missing error when readBack never returns content", async () => {
    const host = flakyHost({ "a.ts": "v1" }, [undefined]);
    const paths = await ProjectPaths.forProject(host);
    const t = new FastWrite(host, paths);
    const p = await t.preview!({ path: "a.ts", content: "v2" });
    await expect(t.execute({ path: "a.ts", content: "v2" }, p, sig)).rejects.toThrow("file missing after write: a.ts");
  });
});

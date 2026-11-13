import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHost } from "@stewart/kernel";
import { changeTracker, type Baseline } from "../src/api.js";
import { nodeHost, sh } from "./nodeHost.js";

const P = { cwd: "/p", stateDir: "/tmp/st", sessionId: "s1" };

function manifestTracker(files: Record<string, string> = {}) {
  const h = fakeHost(files);
  return { tracker: changeTracker(h.host, P), files: h.files, host: h.host };
}

const text = async (host: { files: { readBinary(p: string): Promise<{ base64: string }> } }, p: string) =>
  Buffer.from((await host.files.readBinary(p)).base64, "base64").toString("utf8");

describe("manifest tracker", () => {
  it("sees added, modified and deleted files", async () => {
    const { tracker, files } = manifestTracker({ "a.ts": "old", "b.ts": "keep" });
    const b = await tracker.begin("t");
    files["a.ts"] = "new";
    files["c.ts"] = "added";
    delete files["b.ts"];
    expect(await tracker.diff(b)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
  it("reports [] when nothing changed and undefined when the baseline is unavailable", async () => {
    const { tracker, files } = manifestTracker({ "a.ts": "x" });
    expect(await tracker.diff(await tracker.begin("t"))).toEqual([]);
    const un: Baseline = { id: "", kind: "unavailable", reason: "too big" };
    expect(await tracker.diff(un)).toBeUndefined();
    void files;
  });
  it("restores modified and deleted files and deletes new ones", async () => {
    const { tracker, files, host } = manifestTracker({ "a.ts": "old", "b.ts": "gone" });
    const b = await tracker.begin("t");
    files["a.ts"] = "new";
    files["c.ts"] = "added";
    delete files["b.ts"];
    const r = await tracker.restore(b);
    expect(r.restored).toEqual(["a.ts", "b.ts"]);
    expect(r.deleted).toEqual(["c.ts"]);
    expect(await text(host, "a.ts")).toBe("old");
    expect(await text(host, "b.ts")).toBe("gone");
    expect("c.ts" in files).toBe(false);
  });
  it("round-trips binary content", async () => {
    const { tracker, files, host } = manifestTracker();
    await host.files.writeBinary("bin.dat", Buffer.from([0, 1, 2, 255, 254]).toString("base64"));
    const before = (await host.files.readBinary("bin.dat")).base64;
    const b = await tracker.begin("t");
    files["bin.dat"] = "changed";
    await tracker.restore(b);
    expect((await host.files.readBinary("bin.dat")).base64).toBe(before);
  });
  it("excludes state, vendored and build dirs from scan and diff", async () => {
    const { tracker, files } = manifestTracker({
      "a.ts": "x",
      "node_modules/pkg/index.js": "y",
      ".stewart/plan.md": "z",
      "dist/out.js": "d",
      ".idea/misc.xml": "i",
      "/tmp/st/other.json": "s",
    });
    const b = await tracker.begin("t");
    files["dist/out.js"] = "d2";
    files["node_modules/pkg/index.js"] = "y2";
    expect(await tracker.diff(b)).toEqual([]);
  });
  it("is unavailable over the file count limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`f${i}.ts`] = "x";
    const { tracker } = manifestTracker(files);
    const b = await tracker.begin("t");
    expect(b.kind).toBe("unavailable");
    expect(b.reason).toContain("2000");
  });
  it("is unavailable over the size limit", async () => {
    const { tracker } = manifestTracker({ "big.bin": `b64:${Buffer.alloc(21 * 1024 * 1024).toString("base64")}` });
    const b = await tracker.begin("t");
    expect(b.kind).toBe("unavailable");
    expect(b.reason).toContain("bytes");
  });
  it("is unavailable when the listing hits the host cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) files[`f${i}.ts`] = "x";
    const { tracker } = manifestTracker(files);
    const b = await tracker.begin("t");
    expect(b.kind).toBe("unavailable");
    expect(b.reason).toContain("capped");
  });
  it("restore throws on an unavailable baseline", async () => {
    const { tracker } = manifestTracker({ "a.ts": "x" });
    await expect(tracker.restore({ id: "", kind: "unavailable", reason: "too many" })).rejects.toThrow("change tracking unavailable: too many");
  });
  it("restore refuses when the current scan is unavailable", async () => {
    const files: Record<string, string> = { "a.ts": "x" };
    const { tracker } = manifestTracker(files);
    const b = await tracker.begin("t");
    for (let i = 0; i < 2001; i++) files[`f${i}.ts`] = "x";
    await expect(tracker.restore(b)).rejects.toThrow("change tracking unavailable");
  });
  it("serializes baseline ids and re-derives kind with baseline()", async () => {
    const { tracker } = manifestTracker({ "a.ts": "x" });
    const b1 = await tracker.begin("one");
    const b2 = await tracker.begin("two");
    expect(b1.id).toBe("base-1");
    expect(b2.id).toBe("base-2");
    const back = await tracker.baseline(b1.id);
    expect(back).toEqual({ id: "base-1", kind: "manifest" });
    expect(await tracker.diff(back)).toEqual([]);
  });
});

describe("git tracker", () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "st-track-"));
    sh(root, "git", "init", "-q");
    sh(root, "git", "config", "user.email", "t@t");
    sh(root, "git", "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, "del.txt"), "d\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-qm", "init");
    return { root, state: `${root}/state` };
  };

  it("baselines, diffs and restores a real worktree", async () => {
    const { root, state } = repo();
    try {
      const t = changeTracker(nodeHost(root), { cwd: root, stateDir: state, sessionId: "s1" });
      const b = await t.begin("turn-1");
      expect(b.kind).toBe("git");
      writeFileSync(join(root, "a.txt"), "two\n");
      writeFileSync(join(root, "new.txt"), "n\n");
      rmSync(join(root, "del.txt"));
      expect(await t.diff(b)).toEqual(["a.txt", "del.txt", "new.txt"]);
      const r = await t.restore(b);
      expect(r.restored).toContain("a.txt");
      expect(r.restored).toContain("del.txt");
      expect(r.deleted).toContain("new.txt");
      expect(sh(root, "cat", "a.txt")).toBe("one\n");
      expect(sh(root, "cat", "del.txt")).toBe("d\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps baselines addressable across tracker instances", async () => {
    const { root, state } = repo();
    try {
      const t1 = changeTracker(nodeHost(root), { cwd: root, stateDir: state, sessionId: "s1" });
      const b = await t1.begin("one");
      const t2 = changeTracker(nodeHost(root), { cwd: root, stateDir: state, sessionId: "s1" });
      const back = await t2.baseline(b.id);
      expect(back.kind).toBe("git");
      writeFileSync(join(root, "a.txt"), "two\n");
      expect(await t2.diff(back)).toEqual(["a.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists paths with spaces and non-ASCII names", async () => {
    const { root, state } = repo();
    try {
      const t = changeTracker(nodeHost(root), { cwd: root, stateDir: state, sessionId: "s1" });
      const b = await t.begin("turn");
      writeFileSync(join(root, "my file é.txt"), "x\n");
      expect(await t.diff(b)).toEqual(["my file é.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries a temp-index op once and propagates a second failure", async () => {
    const h = fakeHost();
    const calls: string[][] = [];
    h.setProcHandler((argv, onData) => {
      calls.push(argv);
      if (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") {
        onData("true\n");
        return { code: 0 };
      }
      if (argv[1] === "rev-parse") {
        onData("abc\n");
        return { code: 0 };
      }
      if (argv[1] === "read-tree") return { code: 0 };
      if (argv[1] === "add") return { code: 128 };
      return { code: 0 };
    });
    const t = changeTracker(h.host, P);
    await expect(t.begin("x")).rejects.toThrow("git add failed (128)");
    expect(calls.filter((a) => a[1] === "add").length).toBe(2);
  });
});

describe("dispose", () => {
  it("removes the checkpoint dir, blobs and temp index of a manifest project", async () => {
    const { tracker, files } = manifestTracker({
      "/tmp/st/checkpoints/s1/m.json": "{}",
      "/tmp/st/checkpoints/s1/blobs/ab": "blob",
      "/tmp/st/checkpoints/s1.index": "",
    });
    await tracker.dispose();
    expect(Object.keys(files).filter((k) => k.includes("checkpoints"))).toEqual([]);
  });

  it("deletes the git session ref and ignores a failure", async () => {
    const h = fakeHost();
    const calls: string[][] = [];
    h.setProcHandler((argv, onData) => {
      calls.push(argv);
      if (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") onData("true\n");
      return { code: argv[1] === "update-ref" ? 128 : 0 };
    });
    await changeTracker(h.host, P).dispose();
    expect(calls).toContainEqual(["git", "update-ref", "-d", "refs/stewart/s1"]);
  });
});


import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as vsc from "./vscode.stub.js";
import { VsCodeHost } from "../src/host.js";
import { DiffContent } from "../src/diffContent.js";

let root = "";

function hostAt(): VsCodeHost {
  vsc.workspace.workspaceFolders = [{ uri: vsc.Uri.file(root) }];
  const ctx = {
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    globalStorageUri: { fsPath: join(root, ".st") },
  };
  return new VsCodeHost(ctx as never, new DiffContent());
}

beforeEach(() => {
  vsc.resetVscode();
  root = mkdtempSync(join(tmpdir(), "stewart-host-"));
});

describe("files.edit", () => {
  it("saves the document to disk after applying", async () => {
    writeFileSync(join(root, "a.txt"), "old");
    const h = hostAt();
    const r = await h.files.edit({ path: "a.txt", content: "new" });
    expect(r.applied).toBe(true);
    expect(vsc.saveCalls).toEqual([join(root, "a.txt")]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new");
  });

  it("throws when the document cannot be saved", async () => {
    writeFileSync(join(root, "a.txt"), "old");
    vsc.setSaveResult(false);
    const h = hostAt();
    await expect(h.files.edit({ path: "a.txt", content: "new" })).rejects.toThrow("could not save a.txt");
  });

  it("throws file not found for a missing file", async () => {
    const h = hostAt();
    await expect(h.files.edit({ path: "ghost.txt", content: "x" })).rejects.toThrow("file not found");
  });
});

describe("files.read / readBack", () => {
  it("reads disk text and carries no version", async () => {
    writeFileSync(join(root, "a.txt"), "disk");
    const h = hostAt();
    expect(await h.files.read("a.txt")).toEqual({ content: "disk" });
  });

  it("returns an open dirty buffer's text and version", async () => {
    writeFileSync(join(root, "a.txt"), "disk");
    const h = hostAt();
    const doc = await vsc.workspace.openTextDocument(vsc.Uri.file(join(root, "a.txt")));
    doc.text = "buffer";
    doc.isDirty = true;
    doc.version = 7;
    const r = await h.files.read("a.txt");
    expect(r).toEqual({ content: "buffer", version: 7 });
    expect(await h.files.readBack("a.txt")).toBe("disk");
  });

  it("throws file not found for a missing file", async () => {
    const h = hostAt();
    await expect(h.files.read("ghost.txt")).rejects.toThrow("file not found");
  });
});

describe("files.writeAtomic", () => {
  it("creates parent directories", async () => {
    const h = hostAt();
    await h.files.writeAtomic("sub/dir/f.txt", "data");
    expect(readFileSync(join(root, "sub/dir/f.txt"), "utf8")).toBe("data");
  });

  it("survives 20 concurrent writes to the same path", async () => {
    const h = hostAt();
    const values = Array.from({ length: 20 }, (_, i) => `v${i}`);
    await Promise.all(values.map((v) => h.files.writeAtomic("x.txt", v)));
    expect(values).toContain(readFileSync(join(root, "x.txt"), "utf8"));
    const leftovers = (await import("node:fs/promises")).readdir(root);
    expect((await leftovers).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("replaces an existing file", async () => {
    writeFileSync(join(root, "x.txt"), "one");
    const h = hostAt();
    await h.files.writeAtomic("x.txt", "two");
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("two");
    expect(existsSync(join(root, "x.txt"))).toBe(true);
  });
});

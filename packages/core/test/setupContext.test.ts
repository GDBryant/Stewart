import { describe, expect, it } from "vitest";
import { gatherHardware, scanWorkspace, SCAN_FILE_CAP } from "../src/setupContext.js";
import { fakeHost } from "@stewart/kernel";

describe("scanWorkspace", () => {
  it("counts files, lines and languages and classifies a small workspace", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`src/f${i}.ts`] = "a\nb\nc\n";
    files["README.md"] = "hello";
    const { host } = fakeHost(files);
    const w = await scanWorkspace(host);
    expect(w.files).toBe(6);
    expect(w.loc).toBe(16);
    expect(w.languages.TypeScript).toBe(5);
    expect(w.monorepo).toBe(false);
    expect(w.sizeClass).toBe("small");
  });

  it("detects monorepos via workspace markers and multiple package.json files", async () => {
    const marker = await scanWorkspace(fakeHost({ "pnpm-workspace.yaml": "packages:", "a.ts": "x" }).host);
    expect(marker.monorepo).toBe(true);
    const pkgs = await scanWorkspace(
      fakeHost({ "a/package.json": "{}", "b/package.json": "{}", "c/package.json": "{}", "x.ts": "y" }).host,
    );
    expect(pkgs.monorepo).toBe(true);
    const single = await scanWorkspace(fakeHost({ "package.json": "{}", "x.ts": "y" }).host);
    expect(single.monorepo).toBe(false);
  });

  it("flags large workspaces", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12_000; i++) files[`f${i}.ts`] = "x";
    const w = await scanWorkspace(fakeHost(files).host);
    expect(w.sizeClass).toBe("large");
    expect(w.files).toBeLessThanOrEqual(SCAN_FILE_CAP);
  });
});

describe("gatherHardware", () => {
  it("parses nvidia-smi output and reports RAM", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler((argv, onData) => {
      expect(argv[0]).toBe("nvidia-smi");
      onData("NVIDIA GeForce RTX 4090, 24564 MiB\nNVIDIA RTX A5000, 24564 MiB\n");
      return { code: 0 };
    });
    const h = await gatherHardware(host);
    expect(h.ramGb).toBeGreaterThan(0);
    expect(h.gpus).toHaveLength(2);
    expect(h.gpus![0].name).toBe("NVIDIA GeForce RTX 4090");
    expect(h.gpus![0].vramGb).toBeCloseTo(24, 0);
  });

  it("omits gpus when detection fails, never throws", async () => {
    const { host, setProcHandler } = fakeHost();
    setProcHandler(() => ({ code: 1 }));
    const h = await gatherHardware(host);
    expect(h.ramGb).toBeGreaterThan(0);
    expect(h.gpus).toBeUndefined();
  });
});

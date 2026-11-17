import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEWART_VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("STEWART_VERSION", () => {
  it("equals the version in hosts/vscode/package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "hosts/vscode/package.json"), "utf8")) as { version: string };
    expect(STEWART_VERSION).toBe(pkg.version);
  });

  it("is semver-shaped", () => {
    expect(STEWART_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

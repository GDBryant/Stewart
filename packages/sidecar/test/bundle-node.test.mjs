import { describe, expect, it } from "vitest";
import { NODE_VERSION, TARGETS, sha256Hex, shasumFor, verifyArchive } from "../../../scripts/bundle-node.mjs";

describe("bundle-node targets", () => {
  it("maps every required platform to an archive and exe name", () => {
    expect(Object.keys(TARGETS).sort()).toEqual(["linux-arm64", "linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
    expect(TARGETS["linux-x64"].archive).toBe("node-v{v}-linux-x64.tar.gz");
    expect(TARGETS["linux-arm64"].archive).toBe("node-v{v}-linux-arm64.tar.gz");
    expect(TARGETS["macos-x64"].archive).toBe("node-v{v}-darwin-x64.tar.gz");
    expect(TARGETS["macos-arm64"].archive).toBe("node-v{v}-darwin-arm64.tar.gz");
    expect(TARGETS["windows-x64"].archive).toBe("node-v{v}-win-x64.zip");
    expect(TARGETS["windows-x64"].exe).toBe("node.exe");
    expect(TARGETS["windows-x64"].zip).toBe(true);
    for (const [key, t] of Object.entries(TARGETS)) {
      if (key !== "windows-x64") {
        expect(t.exe).toBe("node");
        expect(t.member).toBe("bin/node");
      }
      expect(t.archive).toContain("{v}");
      expect(t.archive.replace("{v}", NODE_VERSION)).not.toContain("{v}");
    }
  });
});

describe("checksum verification", () => {
  const payload = Buffer.from("fake node archive");
  const shasums = `deadbeef  node-v22.20.0-linux-arm64.tar.gz\n${sha256Hex(payload)}  node-v22.20.0-linux-x64.tar.gz\n`;

  it("finds the expected digest for a filename", () => {
    expect(shasumFor(shasums, "node-v22.20.0-linux-x64.tar.gz")).toBe(sha256Hex(payload));
    expect(shasumFor(shasums, "node-v22.20.0-darwin-x64.tar.gz")).toBeUndefined();
  });

  it("accepts an archive whose sha256 matches SHASUMS256", () => {
    expect(() => verifyArchive(shasums, "node-v22.20.0-linux-x64.tar.gz", payload)).not.toThrow();
  });

  it("rejects a tampered archive", () => {
    expect(() => verifyArchive(shasums, "node-v22.20.0-linux-x64.tar.gz", Buffer.from("tampered"))).toThrow(/sha256 mismatch/);
  });

  it("rejects an archive missing from SHASUMS256", () => {
    expect(() => verifyArchive(shasums, "node-v22.20.0-darwin-arm64.tar.gz", payload)).toThrow(/no SHASUMS256 entry/);
  });

  it("handles the '*filename' shasum format", () => {
    const star = `${sha256Hex(payload)} *node-v22.20.0-win-x64.zip\n`;
    expect(shasumFor(star, "node-v22.20.0-win-x64.zip")).toBe(sha256Hex(payload));
  });
});

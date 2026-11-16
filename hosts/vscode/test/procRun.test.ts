import { describe, expect, it } from "vitest";
import { procRun } from "../src/procRun.js";

describe("procRun", () => {
  it("gives the child no readable stdin (immediate EOF)", async () => {
    let out = "";
    const proc = procRun([process.execPath, "-e", "process.stdin.on('data',()=>process.exit(1));process.stdin.on('end',()=>console.log('eof'))"], {
      cwd: "/",
      onData: (d) => (out += d),
    });
    const { code } = await proc.done;
    expect(code).toBe(0);
    expect(out).toContain("eof");
  });

  it("reports a cause and code -1 when the binary does not exist", async () => {
    let out = "";
    const proc = procRun(["stewart-no-such-binary-xyz"], { cwd: "/", onData: (d) => (out += d) });
    const { code } = await proc.done;
    expect(code).toBe(-1);
    expect(out).toContain("cannot start stewart-no-such-binary-xyz:");
  });

  it("runs a real process and resolves its exit code", async () => {
    const proc = procRun([process.execPath, "-e", "console.log('ok')"], { cwd: "/", onData: () => {} });
    expect(await proc.done).toEqual({ code: 0 });
  });
});

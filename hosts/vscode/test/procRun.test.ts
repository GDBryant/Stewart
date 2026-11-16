import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { procRun } from "../src/procRun.js";

beforeAll(() => {
  const script = join(mkdtempSync(join(tmpdir(), "stewart-shell-")), "sh");
  writeFileSync(script, "#!/bin/sh\nprintf '__STEWART_ENV__STEWART_TESTVAR=fromshell\\0'\n");
  chmodSync(script, 0o755);
  process.env.SHELL = script;
});

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
    const { code, cause } = await proc.done;
    expect(code).toBe(-1);
    expect(cause).toContain("cannot start stewart-no-such-binary-xyz:");
    expect(out).toContain("cannot start stewart-no-such-binary-xyz:");
  });

  it("names the signal when a process is killed", async () => {
    const proc = procRun([process.execPath, "-e", "process.kill(process.pid,'SIGKILL')"], { cwd: "/", onData: () => {} });
    expect(await proc.done).toEqual({ code: -1, cause: "killed by signal SIGKILL" });
  });

  it("runs a real process and resolves its exit code", async () => {
    const proc = procRun([process.execPath, "-e", "console.log('ok')"], { cwd: "/", onData: () => {} });
    expect(await proc.done).toEqual({ code: 0 });
  });

  it("passes the resolved login-shell env to the command", async () => {
    let out = "";
    const proc = procRun([process.execPath, "-e", "console.log(process.env.STEWART_TESTVAR ?? 'missing')"], {
      cwd: "/",
      onData: (d) => (out += d),
    });
    expect(await proc.done).toEqual({ code: 0 });
    expect(out).toContain("fromshell");
  });
});

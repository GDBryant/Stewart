import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDebugSink, pruneDebugLogs } from "../src/debugSink.js";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "stewart-debuglog-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const debugLine = (day: string) => `[${day}T10:00:00.000Z] [outgoing] [ollama] [m] [{}]`;

describe("FileDebugSink", () => {
  it("appends formatted lines to the UTC-day file with owner-only mode", async () => {
    const dir = join(tmp(), "logs");
    const sink = new FileDebugSink({ dir: () => dir, retainDays: 7, now: () => new Date("2026-11-06T12:00:00Z"), flushMs: 5 });
    sink.record({ direction: "outgoing", provider: "ollama", model: "m", payload: "{}" });
    sink.record({ direction: "error", provider: "ollama", model: "m", payload: "boom" });
    sink.flush();
    const file = join(dir, "2026-11-06.log");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[2026-11-06T12:00:00\.000Z\] \[outgoing\] \[ollama\] \[m\] \[\{\}\]$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes after the timer without an explicit flush", async () => {
    const dir = tmp();
    const sink = new FileDebugSink({ dir: () => dir, retainDays: 0, flushMs: 5 });
    sink.record({ direction: "stderr", provider: "claude-cli", model: "s", payload: "x" });
    await new Promise((r) => setTimeout(r, 40));
    expect(readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true);
  });

  it("negative: drops lines until the host announces a log dir and never throws", () => {
    const sink = new FileDebugSink({ dir: () => undefined, retainDays: 7, flushMs: 1000 });
    expect(() => {
      sink.record({ direction: "outgoing", provider: "p", model: "m", payload: "x" });
      sink.flush();
    }).not.toThrow();
  });

  it("negative: a file that cannot be written does not throw", () => {
    const blocker = join(tmp(), "not-a-dir");
    writeFileSync(blocker, "x");
    const sink = new FileDebugSink({ dir: () => join(blocker, "sub"), retainDays: 7, flushMs: 1000 });
    expect(() => {
      sink.record({ direction: "error", provider: "p", model: "m", payload: "x" });
      sink.flush();
    }).not.toThrow();
  });
});

describe("pruneDebugLogs", () => {
  it("deletes debug-log files older than retainDays and keeps today plus N previous days", () => {
    const dir = tmp();
    for (const day of ["2026-11-06", "2026-11-03", "2026-11-02", "2026-10-30", "2026-10-29"]) writeFileSync(join(dir, `${day}.log`), `${debugLine(day)}\n`);
    const removed = pruneDebugLogs(dir, "2026-11-06", 3);
    expect(removed.sort()).toEqual(["2026-10-29.log", "2026-10-30.log", "2026-11-02.log"]);
    expect(readdirSync(dir).sort()).toEqual(["2026-11-03.log", "2026-11-06.log"]);
  });

  it("removes rotated chunks (yyyy-MM-dd.N.log) under the same rule", () => {
    const dir = tmp();
    writeFileSync(join(dir, "2026-10-01.1.log"), `${debugLine("2026-10-01")}\n`);
    writeFileSync(join(dir, "2026-10-01.log"), `${debugLine("2026-10-01")}\n`);
    expect(pruneDebugLogs(dir, "2026-11-06", 7).sort()).toEqual(["2026-10-01.1.log", "2026-10-01.log"]);
  });

  it("negative: retainDays 0 never prunes", () => {
    const dir = tmp();
    writeFileSync(join(dir, "2020-01-01.log"), `${debugLine("2020-01-01")}\n`);
    expect(pruneDebugLogs(dir, "2026-11-06", 0)).toEqual([]);
    expect(existsSync(join(dir, "2020-01-01.log"))).toBe(true);
  });

  it("negative: keeps old files whose first line is not a debug-log line, and non-matching names", () => {
    const dir = tmp();
    writeFileSync(join(dir, "2020-01-01.log"), "some other tool's log\n");
    writeFileSync(join(dir, "2020-01-02.log"), "");
    writeFileSync(join(dir, "notes-2020-01-03.log"), `${debugLine("2020-01-03")}\n`);
    mkdirSync(join(dir, "2020-01-04.log"));
    expect(pruneDebugLogs(dir, "2026-11-06", 7)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["2020-01-01.log", "2020-01-02.log", "2020-01-04.log", "notes-2020-01-03.log"]);
  });

  it("negative: a missing folder is not an error", () => {
    expect(pruneDebugLogs(join(tmp(), "missing"), "2026-11-06", 7)).toEqual([]);
  });

  it("prunes when the sink opens a new day", async () => {
    const dir = tmp();
    const old = join(dir, "2026-10-01.log");
    writeFileSync(old, `${debugLine("2026-10-01")}\n`);
    utimesSync(old, new Date(0), new Date(0));
    const sink = new FileDebugSink({ dir: () => dir, retainDays: 7, now: () => new Date("2026-11-06T00:00:00Z"), flushMs: 1000 });
    sink.record({ direction: "error", provider: "p", model: "m", payload: "x" });
    sink.flush();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "2026-11-06.log"))).toBe(true);
  });
});

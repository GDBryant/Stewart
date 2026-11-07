import { describe, expect, it } from "vitest";
import { DebugLogger, DEBUG_LINE_RE, eventEntry, formatDebugLine, redact, type DebugEntry, type DebugSink } from "../src/api.js";


class Capture implements DebugSink {
  entries: DebugEntry[] = [];
  record(e: DebugEntry): void {
    this.entries.push(e);
  }
}

describe("formatDebugLine", () => {
  it("writes one line in the v1 format with an ISO timestamp", () => {
    const line = formatDebugLine({ ts: new Date("2026-11-06T10:00:00.000Z"), direction: "outgoing", provider: "ollama", model: "qwen", payload: "{}" });
    expect(line).toBe("[2026-11-06T10:00:00.000Z] [outgoing] [ollama] [qwen] [{}]");
    expect(DEBUG_LINE_RE.test(line)).toBe(true);
  });

  it("escapes backslash, CR, LF and TAB so payloads stay on one line", () => {
    const line = formatDebugLine({ ts: new Date(0), direction: "incoming", provider: "p", model: "m", payload: 'a\\b\r\nc\td' });
    expect(line.endsWith("[a\\\\b\\r\\nc\\td]")).toBe(true);
    expect(line.includes("\n")).toBe(false);
  });

  it("negative: text that is not a debug line does not match the line pattern", () => {
    expect(DEBUG_LINE_RE.test("2026-11-06 some other log")).toBe(false);
    expect(DEBUG_LINE_RE.test("[2026-11-06T00:00:00Z] [bogus] [x] [y] [z]")).toBe(false);
  });
});

describe("redact", () => {
  it("replaces Authorization header values and standalone Bearer tokens", () => {
    expect(redact('{"authorization":"Bearer sk-abc123"}')).toBe('{"authorization":"[REDACTED]"}');
    expect(redact("Authorization: Bearer sk-abc123")).toBe("Authorization: [REDACTED]");
    expect(redact("curl -H 'x' Bearer abc.def-ghi=")).toBe("curl -H 'x' [REDACTED]");
  });

  it("replaces exact secret strings everywhere they occur", () => {
    expect(redact("key=sk-live-999 and sk-live-999", ["sk-live-999"])).toBe("key=[REDACTED] and [REDACTED]");
  });

  it("negative: leaves unrelated text and empty secrets alone", () => {
    expect(redact("hello world, authors list", [""])).toBe("hello world, authors list");
    expect(redact("token is not a bearer", ["unrelated-secret"])).toBe("token is not a bearer");
  });
});

describe("DebugLogger", () => {
  it("off writes nothing", () => {
    const cap = new Capture();
    const log = new DebugLogger();
    log.configure("off", cap);
    log.record({ direction: "outgoing", provider: "p", model: "m", payload: "x" });
    expect(cap.entries).toHaveLength(0);
  });

  it("calls records provider traffic but drops bus events", () => {
    const cap = new Capture();
    const log = new DebugLogger();
    log.configure("calls", cap);
    log.record({ direction: "error", provider: "p", model: "m", payload: "boom" });
    log.record({ direction: "event", provider: "core", model: "-", payload: "{}" });
    expect(cap.entries.map((e) => e.direction)).toEqual(["error"]);
  });

  it("full records bus events and redacts secrets before the sink sees them", () => {
    const cap = new Capture();
    const log = new DebugLogger(() => ["sk-secret"]);
    log.configure("full", cap);
    log.record({ direction: "event", provider: "core", model: "-", payload: '{"k":"sk-secret"}' });
    expect(cap.entries[0].payload).toBe('{"k":"[REDACTED]"}');
    expect(cap.entries[0].ts).toBeInstanceOf(Date);
  });

  it("never throws when the sink throws", () => {
    const log = new DebugLogger();
    log.configure("calls", {
      record() {
        throw new Error("disk full");
      },
    });
    expect(() => log.record({ direction: "stderr", provider: "p", model: "m", payload: "x" })).not.toThrow();
  });

  it("eventEntry skips text deltas and serialises other events", () => {
    expect(eventEntry({ kind: "text_delta", runId: "r", seq: 0, text: "a" })).toBeUndefined();
    expect(eventEntry({ kind: "run.finished", runId: "r", status: "done" })).toMatchObject({ direction: "event", provider: "core" });
  });
});

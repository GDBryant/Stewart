import { describe, expect, it } from "vitest";
import { DebugLogger, DEBUG_LINE_RE, eventEntry, formatDebugLine, redact, type DebugEntry, type DebugSink } from "../src/debug/debug.js";
import { Core } from "../src/core.js";
import { OllamaAdapter } from "../src/channels/ollama.js";
import { OpenAICompatAdapter } from "../src/channels/openai.js";
import { ClaudeCliAdapter } from "../src/channels/claude/adapter.js";
import type { SpawnFn } from "../src/channels/claude/nodeSpawn.js";
import type { ChatRequest, ChannelConfig } from "../src/channels/types.js";
import type { ConfigLayer } from "../src/config/loader.js";
import type { ConfigStore } from "../src/config/store.js";
import { collect, fakeFetcher, fakeHost } from "./helpers.js";

class Capture implements DebugSink {
  entries: DebugEntry[] = [];
  record(e: DebugEntry): void {
    this.entries.push(e);
  }
}

const req = (): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal });
const ollamaCfg: ChannelConfig = { id: "o", type: "ollama", enabled: true, baseUrl: "http://x", maxParallel: 1 };
const openaiCfg: ChannelConfig = { id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h/v1", maxParallel: 4 };

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

describe("adapter debug hooks", () => {
  it("Ollama records request with num_ctx prefix, each NDJSON chunk, and an incomplete-stream error", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":false}'] }]);
    const cfg = { ...ollamaCfg, modelCaps: { m: { numCtx: 8192 } } };
    await collect(new OllamaAdapter({ fetcher, debug: cap }).chat(cfg, undefined, req()));
    expect(cap.entries[0]).toMatchObject({ direction: "outgoing", provider: "ollama", model: "m" });
    expect(cap.entries[0].payload.startsWith("num_ctx=8192 {")).toBe(true);
    expect(cap.entries[1]).toMatchObject({ direction: "incoming" });
    expect(cap.entries.at(-1)).toMatchObject({ direction: "error", payload: "stream ended before done" });
  });

  it("Ollama records HTTP errors and connection failures, then rethrows", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ status: 500, body: '{"error":"model x not found"}' }]);
    await expect(collect(new OllamaAdapter({ fetcher, debug: cap }).chat(ollamaCfg, undefined, req()))).rejects.toThrow("model x not found");
    expect(cap.entries.at(-1)).toMatchObject({ direction: "error" });
    expect(cap.entries.at(-1)?.payload.trim()).toBe('HTTP 500: {"error":"model x not found"}');

    const cap2 = new Capture();
    const failing = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(collect(new OllamaAdapter({ fetcher: failing, debug: cap2 }).chat(ollamaCfg, undefined, req()))).rejects.toThrow("ECONNREFUSED");
    expect(cap2.entries.map((e) => e.direction)).toEqual(["outgoing", "error"]);
    expect(cap2.entries[1].payload).toBe("connection failed: ECONNREFUSED");
  });

  it("negative: Ollama with no debug sink still streams normally", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"ok"},"done":false}', '{"done":true}'] }]);
    const evs = await collect(new OllamaAdapter({ fetcher }).chat(ollamaCfg, undefined, req()));
    expect(evs.some((e) => e.kind === "text")).toBe(true);
  });

  it("OpenAI-compatible records request, each SSE payload and HTTP errors", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ body: ['data: {"choices":[{"delta":{"content":"x"}}]}', "data: [DONE]"] }]);
    await collect(new OpenAICompatAdapter({ fetcher, debug: cap }).chat(openaiCfg, "sk", req()));
    expect(cap.entries[0]).toMatchObject({ direction: "outgoing", provider: "openai-compatible" });
    expect(cap.entries[1]).toMatchObject({ direction: "incoming", payload: '{"choices":[{"delta":{"content":"x"}}]}' });

    const cap2 = new Capture();
    const { fetcher: f2 } = fakeFetcher([{ status: 500, body: "boom" }]);
    await expect(collect(new OpenAICompatAdapter({ fetcher: f2, debug: cap2 }).chat(openaiCfg, "sk", req()))).rejects.toThrow(/500/);
    expect(cap2.entries.at(-1)?.payload.trim()).toBe("HTTP 500: boom");
  });

  it("Claude CLI records stdin, stdout lines, stderr and non-zero exit", async () => {
    const cap = new Capture();
    const spawn: SpawnFn = () => {
      let doneRes: (r: { code: number }) => void = () => {};
      const done = new Promise<{ code: number }>((res) => (doneRes = res));
      return {
        stdin: () => {},
        stdout: (async function* () {
          yield '{"type":"system"}';
          doneRes({ code: 2 });
        })(),
        stderrText: async () => "Error: boom",
        done,
        kill: async () => {},
      };
    };
    const adapter = new ClaudeCliAdapter({ spawn, debug: cap, makeTempDir: async () => "/tmp/x", writeTempFile: async () => "/tmp/x/p", rmDir: async () => {} });
    await expect(collect(adapter.chat({ id: "c", type: "claude-cli", enabled: true, maxParallel: 1 }, undefined, { ...req(), model: "sonnet" }))).rejects.toThrow();
    const kinds = cap.entries.map((e) => `${e.direction}:${e.provider}`);
    expect(kinds[0]).toBe("outgoing:claude-cli");
    expect(kinds).toContain("incoming:claude-cli");
    expect(cap.entries).toContainEqual(expect.objectContaining({ direction: "stderr", payload: "Error: boom" }));
    expect(cap.entries).toContainEqual(expect.objectContaining({ direction: "error", payload: "exit code 2" }));
  });
});

describe("Core debug wiring", () => {
  const store = (layer: ConfigLayer = {}): ConfigStore => ({
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  });

  it("builds a sink only when settings.log is not off, and rebuilds only when level or retention changes", async () => {
    const built: { level: string; retainDays: number }[] = [];
    const user = store({ "settings.yaml": "version: 1\nlog:\n  level: calls\n  retainDays: 3\n" });
    const core = new Core({
      defaults: {},
      userConfig: user,
      projectConfig: async () => store(),
      debugSinkFactory: (o) => {
        built.push(o);
        return new Capture();
      },
      emitEvent: () => {},
    });
    await core.attachProject("p1", fakeHost({}).host);
    expect(built).toEqual([{ level: "calls", retainDays: 3 }]);
    await core.dispatch("config.reload", { projectId: "p1" });
    expect(built).toHaveLength(1);
    user.write("settings.yaml", "version: 1\nlog:\n  level: calls\n  retainDays: 9\n");
    await core.dispatch("config.reload", { projectId: "p1" });
    expect(built.at(-1)).toEqual({ level: "calls", retainDays: 9 });
  });

  it("negative: default (off) never calls the factory", async () => {
    let calls = 0;
    const core = new Core({
      defaults: {},
      userConfig: store(),
      projectConfig: async () => store(),
      debugSinkFactory: () => {
        calls++;
        return new Capture();
      },
      emitEvent: () => {},
    });
    await core.attachProject("p1", fakeHost({}).host);
    expect(calls).toBe(0);
  });

  it("full level records bus events; calls level does not; text deltas are skipped", async () => {
    const run = async (level: string) => {
      const cap = new Capture();
      const core = new Core({
        defaults: {},
        userConfig: store({ "settings.yaml": `version: 1\nlog:\n  level: ${level}\n` }),
        projectConfig: async () => store(),
        debugSinkFactory: () => cap,
        emitEvent: () => {},
      });
      await core.attachProject("p1", fakeHost({}).host);
      const bus = (core as unknown as { bus: { emit(ev: unknown): void; flush(): void } }).bus;
      bus.emit({ kind: "text_delta", runId: "r", seq: 0, text: "a" });
      bus.emit({ kind: "run.finished", runId: "r", status: "done" });
      bus.flush();
      await new Promise((r) => setTimeout(r, 5));
      return cap.entries;
    };
    const full = await run("full");
    expect(full.map((e) => e.direction)).toEqual(["event"]);
    expect(full[0].payload).toContain("run.finished");
    expect(await run("calls")).toEqual([]);
  });
});

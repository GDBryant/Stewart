import { describe, expect, it } from "vitest";
import { DebugLogger, DEBUG_LINE_RE, eventEntry, formatDebugLine, redact, type DebugEntry, type DebugSink } from "@stewart/diagnostics";
import { Core } from "../src/core.js";
import { OllamaAdapter } from "../src/channels/ollama.js";
import { OpenAICompatAdapter } from "../src/channels/openai.js";
import { ClaudeCliAdapter } from "../src/channels/claude/adapter.js";
import type { SpawnFn } from "../src/channels/claude/nodeSpawn.js";
import type { ChatRequest, ChannelConfig } from "../src/channels/types.js";
import type { ConfigLayer } from "../src/config/loader.js";
import type { ConfigStore } from "../src/config/store.js";
import { collect, fakeFetcher, fakeHost } from "@stewart/kernel";

class Capture implements DebugSink {
  entries: DebugEntry[] = [];
  record(e: DebugEntry): void {
    this.entries.push(e);
  }
}

const req = (): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal });
const ollamaCfg: ChannelConfig = { id: "o", type: "ollama", enabled: true, baseUrl: "http://x", maxParallel: 1 };
const openaiCfg: ChannelConfig = { id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h/v1", maxParallel: 4 };

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

describe("Ollama context sizing", () => {
  it("autoNumCtx leaves small prompts alone and sizes large ones within caps", async () => {
    const { autoNumCtx, estimatePromptTokens } = await import("../src/channels/ollama.js");
    expect(autoNumCtx(500)).toBeUndefined();
    expect(autoNumCtx(3000)).toBe(5120);
    expect(autoNumCtx(100_000)).toBe(32768);
    expect(autoNumCtx(3000, 4096)).toBe(4096);
    expect(estimatePromptTokens([{ content: "x".repeat(350) }], undefined)).toBeGreaterThan(100);
  });

  it("records an error when the provider evaluated far fewer tokens than sent", async () => {
    const cap = new Capture();
    const big = "x".repeat(20_000);
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":true,"prompt_eval_count":500,"eval_count":1}'] }]);
    const r = { ...req(), messages: [{ role: "user" as const, content: big }] };
    await collect(new OllamaAdapter({ fetcher, debug: cap }).chat(ollamaCfg, undefined, r));
    expect(cap.entries[0].payload.startsWith("num_ctx=")).toBe(true);
    expect(cap.entries[0].payload).not.toContain("num_ctx=default");
    expect(cap.entries.some((e) => e.direction === "error" && e.payload.includes("prompt truncated"))).toBe(true);
  });

  it("does not flag truncation when counts match", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":true,"prompt_eval_count":12,"eval_count":1}'] }]);
    await collect(new OllamaAdapter({ fetcher, debug: cap }).chat(ollamaCfg, undefined, req()));
    expect(cap.entries.some((e) => e.direction === "error")).toBe(false);
  });
});

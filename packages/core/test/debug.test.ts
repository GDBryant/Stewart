import { describe, expect, it } from "vitest";
import { type DebugEntry, type DebugSink } from "@stewart/diagnostics";
import { Core } from "../src/core.js";
import type { ChatRequest, ChannelConfig } from "@stewart/channels";
import type { ConfigLayer } from "@stewart/config";
import type { ConfigStore } from "@stewart/config";
import { fakeHost } from "@stewart/kernel";

class Capture implements DebugSink {
  entries: DebugEntry[] = [];
  record(e: DebugEntry): void {
    this.entries.push(e);
  }
}

const req = (): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal });
const ollamaCfg: ChannelConfig = { id: "o", type: "ollama", enabled: true, baseUrl: "http://x", maxParallel: 1 };
const openaiCfg: ChannelConfig = { id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h/v1", maxParallel: 4 };

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

import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent, type ChatRequest } from "@stewart/channels";
import { settingsFile } from "@stewart/config";
import { harness, makeConfig } from "./harness.js";

const reviewer = { id: "reviewer", enabled: true, prompt: "You review.", skills: ["code-health"], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };

function blockingChannel(maxParallel: number): { channel: ManagedChannel; calls: number } {
  let calls = 0;
  const state = { calls: 0 };
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* (_cfg: unknown, _s: unknown, req: ChatRequest): AsyncIterable<ChatEvent> {
      const n = ++calls;
      state.calls = calls;
      if (n === 1) {
        yield {
          kind: "tool_calls",
          calls: [0, 1, 2].map((i) => ({ id: `d${i}`, name: "delegate", arguments: { role: "reviewer", task: `review ${i}` } })),
        };
        yield { kind: "done" };
        return;
      }
      await new Promise<void>((res) => {
        if (req.signal.aborted) return res();
        req.signal.addEventListener("abort", () => res(), { once: true });
      });
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  };
  return { channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel }), calls: state.calls };
}

describe("cancel with in-flight delegates", () => {
  it("aborted children unwind the run", async () => {
    const { channel } = blockingChannel(8);
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer], settings: { ...settingsFile.parse({}), runTurnLimit: 2000 } });
    const h = harness({ config, channel });
    const { runId } = await h.svc.send({ text: "health check" });
    await h.waitFor("task.started");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.svc.cancel(runId)).toBe(true);
    const fin = await h.waitFor("run.finished", 5000);
    expect(fin).toMatchObject({ status: "cancelled" });
    expect(h.events.filter((e) => e.kind === "task.failed").length + h.events.filter((e) => e.kind === "task.done").length).toBe(3);
  });

  it("aborted children unwind on a maxParallel:1 channel", async () => {
    const { channel } = blockingChannel(1);
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer], settings: { ...settingsFile.parse({}), runTurnLimit: 2000 } });
    const h = harness({ config, channel });
    const { runId } = await h.svc.send({ text: "health check" });
    await h.waitFor("task.started");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.svc.cancel(runId)).toBe(true);
    const fin = await h.waitFor("run.finished", 5000);
    expect(fin).toMatchObject({ status: "cancelled" });
  });

  it("unwinds even when a child is parked on a stuck tracker op", async () => {
    const { channel } = blockingChannel(8);
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer], settings: { ...settingsFile.parse({}), runTurnLimit: 2000 } });
    const h = harness({ config, channel });
    let adds = 0;
    const sha = (c: string) => `${c.repeat(40)}\n`;
    h.setProcHandler((argv, onData) => {
      if (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") { onData("true\n"); return { code: 0 }; }
      if (argv[1] === "rev-parse") { onData(sha("a")); return { code: 0 }; }
      if (argv[1] === "write-tree") { onData(sha("b")); return { code: 0 }; }
      if (argv[1] === "commit-tree") { onData(sha("c")); return { code: 0 }; }
      if (argv[1] === "add" && ++adds > 2) return "never";
      return { code: 0 };
    });
    const { runId } = await h.svc.send({ text: "health check" });
    await h.waitFor("task.started");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.svc.cancel(runId)).toBe(true);
    const fin = await h.waitFor("run.finished", 5000);
    expect(fin).toMatchObject({ status: "cancelled" });
  });

  it("emits task.failed when a child run throws before finishing", async () => {
    let calls = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* (): AsyncIterable<ChatEvent> {
        if (++calls === 1) {
          yield {
            kind: "tool_calls",
            calls: [0, 1, 2].map((i) => ({ id: `d${i}`, name: "delegate", arguments: { role: "reviewer", task: `review ${i}` } })),
          };
          yield { kind: "done" };
          return;
        }
        yield { kind: "text", text: "summary" };
        yield { kind: "done" };
      },
    };
    const channel = new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 8 });
    const config = makeConfig({ roles: [makeConfig().roles[0], reviewer], settings: { ...settingsFile.parse({}), runTurnLimit: 2000 } });
    const h = harness({ config, channel });
    let adds = 0;
    h.setProcHandler((argv, onData) => {
      if (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") { onData("true\n"); return { code: 0 }; }
      if (argv[1] === "rev-parse") { onData("a".repeat(40) + "\n"); return { code: 0 }; }
      if (argv[1] === "read-tree") return { code: 0 };
      if (argv[1] === "add" && ++adds > 1 && adds <= 7) return { code: 128 };
      return { code: 0 };
    });
    await h.svc.send({ text: "health check" });
    const fin = await h.waitFor("run.finished", 5000);
    expect(fin).toMatchObject({ status: "done" });
    expect(h.events.filter((e) => e.kind === "task.failed").length).toBe(3);
  });
});

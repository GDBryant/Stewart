import { describe, expect, it } from "vitest";
import { Store } from "../src/state.js";
import { MockBridge } from "../src/bridge.js";

function mk() {
  const bridge = new MockBridge();
  return { bridge, store: new Store(bridge) };
}

const ev = (kind: string, extra: Record<string, unknown> = {}) => ({ type: "event" as const, ev: { kind, runId: "r1", ...extra } as never });

const text = (b: MockBridge, t: string) => b.inbound(ev("text_delta", { seq: 0, text: t }));
const tool = (b: MockBridge, callId = "c1") => b.inbound(ev("tool.request", { callId, tool: "read", category: "READ" }));

describe("run segments", () => {
  it("breaks the segment around an answered question", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "before");
    bridge.inbound(ev("ask_user", { questionId: "q1", question: "pick one?", options: ["a", "b"] }));
    store.answer("q1", "a");
    text(bridge, "after");
    const items = store.state.items;
    expect(items).toHaveLength(3);
    expect(items[0].role).toBe("assistant");
    expect(items[0].text).toBe("before");
    expect(items[0].streaming).toBe(false);
    expect(items[1].role).toBe("system");
    expect(items[1].qa).toEqual({ question: "pick one?", answer: "a" });
    expect(items[2].role).toBe("assistant");
    expect(items[2].text).toBe("after");
    expect(items[2].id).not.toBe(items[0].id);
    expect(items[2].runId).toBe("r1");
  });

  it("adds no Q&A item when the question is withdrawn", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "before");
    bridge.inbound(ev("ask_user", { questionId: "q1", question: "pick one?" }));
    bridge.inbound(ev("question.withdrawn", { questionId: "q1" }));
    text(bridge, "after");
    const items = store.state.items;
    expect(items).toHaveLength(2);
    expect(items.every((i) => !i.qa)).toBe(true);
    expect(items[0].streaming).toBe(false);
    expect(items[1].text).toBe("after");
  });

  it("inserts a paragraph break when steps sit between text deltas", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "part one");
    tool(bridge);
    text(bridge, "part two");
    const items = store.state.items;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("part one\n\npart two");
  });

  it("adds no separator for consecutive deltas without steps", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "one");
    text(bridge, "two");
    expect(store.state.items[0].text).toBe("onetwo");
  });

  it("splits the post-step tail into a final block carrying the files", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "narration");
    tool(bridge);
    text(bridge, "final answer");
    bridge.inbound(ev("run.finished", { status: "done", outcome: { changed: ["a.ts"], verified: "none", baseline: "b1" } }));
    const items = store.state.items;
    const run = items.filter((i) => i.role === "assistant");
    expect(run.map((i) => i.id)).toEqual(["r1", "r1:final"]);
    expect(run[0].text).toBe("narration");
    expect(run[0].filesChanged).toBeUndefined();
    expect(run[1].text).toBe("final answer");
    expect(run[1].filesChanged).toEqual(["a.ts"]);
    expect(run[1].filesBaseline).toBe("b1");
    expect(run[1].activity).toHaveLength(0);
    expect(run.every((i) => i.streaming === false)).toBe(true);
  });

  it("does not split when no step precedes the text", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "all text");
    bridge.inbound(ev("run.finished", { status: "done", outcome: { changed: ["a.ts"], verified: "none" } }));
    const run = store.state.items.filter((i) => i.role === "assistant");
    expect(run).toHaveLength(1);
    expect(run[0].text).toBe("all text");
    expect(run[0].filesChanged).toEqual(["a.ts"]);
  });

  it("lands a tool.outcome on the segment that requested it after a split", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "working");
    tool(bridge, "c1");
    bridge.inbound(ev("ask_user", { questionId: "q1", question: "ok?" }));
    store.answer("q1", "yes");
    text(bridge, "more");
    bridge.inbound(ev("tool.outcome", { callId: "c1", ok: true, summary: "read a.ts" }));
    const items = store.state.items;
    expect(items[0].activity).toEqual([{ kind: "tool-ok", text: "read a.ts", tool: "read", category: "READ" }]);
    expect(items[2].activity).toHaveLength(0);
  });

  it("puts a failure error on the last run segment", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "one");
    bridge.inbound(ev("ask_user", { questionId: "q1", question: "ok?" }));
    store.answer("q1", "yes");
    tool(bridge, "c9");
    bridge.inbound(ev("run.finished", { status: "failed", error: "boom" }));
    const run = store.state.items.filter((i) => i.role === "assistant");
    expect(run).toHaveLength(2);
    expect(run[0].text).toBe("one");
    expect(run[1].text).toBe("boom");
    expect(run.every((i) => i.streaming === false)).toBe(true);
  });

  it("streams all run segments closed on done", () => {
    const { bridge, store } = mk();
    bridge.inbound(ev("run.started", { title: "x" }));
    text(bridge, "a");
    bridge.inbound(ev("ask_user", { questionId: "q1", question: "ok?" }));
    store.answer("q1", "yes");
    text(bridge, "b");
    bridge.inbound(ev("run.finished", { status: "done" }));
    expect(store.state.items.every((i) => !i.streaming)).toBe(true);
  });
});

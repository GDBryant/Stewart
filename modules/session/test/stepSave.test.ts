import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@stewart/kernel";
import { stepSaver } from "../src/stepSave.js";
import { closeOpenCalls } from "../src/turnState.js";

describe("stepSaver", () => {
  it("coalesces a burst of steps into at most two saves", async () => {
    let gate: () => void = () => {};
    let saves = 0;
    const step = stepSaver(() => {
      saves++;
      return new Promise<void>((res) => (gate = res));
    });
    step();
    for (let i = 0; i < 5; i++) step();
    gate();
    await new Promise((r) => setTimeout(r));
    expect(saves).toBe(2);
  });

  it("saves the live state at call time, never a stale snapshot", async () => {
    const live = ["a"];
    const saved: string[][] = [];
    let first = true;
    let gate: () => void = () => {};
    const step = stepSaver(async () => {
      saved.push([...live]);
      if (first) {
        first = false;
        await new Promise<void>((res) => (gate = res));
      }
    });
    step();
    live.splice(0, live.length, "compacted", "b");
    step();
    gate();
    await new Promise((r) => setTimeout(r));
    expect(saved).toEqual([["a"], ["compacted", "b"]]);
  });

  it("swallows a save failure and keeps working", async () => {
    let calls = 0;
    const step = stepSaver(async () => {
      if (++calls === 1) throw new Error("disk full");
    });
    step();
    await new Promise((r) => setTimeout(r));
    step();
    await new Promise((r) => setTimeout(r));
    expect(calls).toBe(2);
  });
});

describe("closeOpenCalls", () => {
  const call = (id: string) => ({ id, name: "T", arguments: {} });

  it("appends an interrupted tool message for each unanswered call", () => {
    const t: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [call("c1"), call("c2")] },
      { role: "tool", toolCallId: "c1", content: "done" },
    ];
    closeOpenCalls(t);
    expect(t).toHaveLength(4);
    expect(t[3]).toMatchObject({ role: "tool", toolCallId: "c2", content: expect.stringContaining("Interrupted") });
  });

  it("appends nothing when all calls are answered", () => {
    const t: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [call("c1")] },
      { role: "tool", toolCallId: "c1", content: "done" },
    ];
    closeOpenCalls(t);
    expect(t).toHaveLength(2);
  });

  it("leaves a trailing user or plain assistant message alone", () => {
    for (const tail of [{ role: "user", content: "u" } as ChatMessage, { role: "assistant", content: "a" } as ChatMessage]) {
      const t: ChatMessage[] = [{ role: "assistant", content: "", toolCalls: [call("c1")] }, tail];
      closeOpenCalls(t);
      expect(t).toHaveLength(2);
    }
  });

  it("ignores an earlier open batch once a later assistant replied", () => {
    const t: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [call("c1")] },
      { role: "assistant", content: "moved on" },
      { role: "user", content: "next" },
    ];
    closeOpenCalls(t);
    expect(t).toHaveLength(3);
  });
});

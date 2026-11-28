import { describe, expect, it } from "vitest";
import { createMessageDispatcher, type RouteMessage } from "../src/messageDispatcher.js";

function deferred<T>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createMessageDispatcher", () => {
  it("runs ordinary requests sequentially in arrival order", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const calls: string[] = [];
    const dispatch = createMessageDispatcher(async (m) => {
      calls.push(m.type);
      if (m.type === "models.refresh") {
        started.resolve();
        await gate.promise;
      }
    });
    const first = dispatch({ type: "models.refresh" });
    const get = dispatch({ type: "config.get" });
    const set = dispatch({ type: "config.set" });
    await started.promise;
    expect(calls).toEqual(["models.refresh"]);
    gate.resolve();
    await Promise.all([first, get, set]);
    expect(calls).toEqual(["models.refresh", "config.get", "config.set"]);
  });

  it.each(["chat.answer", "chat.approve", "chat.cancel", "chat.steer"])("dispatches %s while an ordinary request is pending", async (type) => {
    const gate = deferred<void>();
    const calls: RouteMessage[] = [];
    const dispatch = createMessageDispatcher(async (m) => {
      calls.push(m);
      if (m.type === "models.refresh") await gate.promise;
    });
    const first = dispatch({ type: "models.refresh" });
    const next = dispatch({ type: "config.get" });
    const control = { type, questionId: "q1", answer: "Ask each" };
    try {
      await dispatch(control);
      expect(calls.map((m) => m.type)).toEqual(["models.refresh", type]);
      expect(calls[1]).toBe(control);
    } finally {
      gate.resolve();
      await Promise.all([first, next]);
    }
    expect(calls.map((m) => m.type)).toEqual(["models.refresh", type, "config.get"]);
  });

  it("rejects the caller of a failing ordinary request but still runs the next one", async () => {
    const calls: string[] = [];
    const failure = new Error("nope");
    const dispatch = createMessageDispatcher(async (m) => {
      calls.push(m.type);
      if (m.type === "config.get") throw failure;
    });
    await expect(dispatch({ type: "config.get" })).rejects.toBe(failure);
    await dispatch({ type: "config.set" });
    expect(calls).toEqual(["config.get", "config.set"]);
  });

  it("a failing control message rejects its caller without poisoning the ordinary queue", async () => {
    const gate = deferred<void>();
    const calls: string[] = [];
    const failure = new Error("bad answer");
    const dispatch = createMessageDispatcher(async (m) => {
      calls.push(m.type);
      if (m.type === "models.refresh") await gate.promise;
      if (m.type === "chat.answer") throw failure;
    });
    const first = dispatch({ type: "models.refresh" });
    const next = dispatch({ type: "config.get" });
    try {
      await expect(dispatch({ type: "chat.answer", questionId: "q1" })).rejects.toBe(failure);
      expect(calls).toEqual(["models.refresh", "chat.answer"]);
    } finally {
      gate.resolve();
      await Promise.all([first, next]);
    }
    expect(calls).toEqual(["models.refresh", "chat.answer", "config.get"]);
  });

  it("a synchronous throw rejects the returned promise without blocking later work", async () => {
    const calls: string[] = [];
    const failure = new Error("sync");
    const dispatch = createMessageDispatcher((m) => {
      calls.push(m.type);
      if (m.type === "config.get") throw failure;
      return Promise.resolve();
    });
    await expect(dispatch({ type: "config.get" })).rejects.toBe(failure);
    await dispatch({ type: "config.set" });
    expect(calls).toEqual(["config.get", "config.set"]);
  });
});

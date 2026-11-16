import { describe, expect, it } from "vitest";
import { exitCause, isStartFailure, withStartRetry } from "../src/procStart.js";
import type { ProcessHandle, ProcessPort } from "../src/ports.js";

const START = 3221225794;

type Run = ProcessPort["proc"]["run"];

function fakeRun(codes: number[], opts: { emit?: string } = {}): { run: Run; calls: number; killed: number } {
  const state = { calls: 0, killed: 0 };
  const run: Run = (_argv, o) => {
    const i = state.calls++;
    const h: ProcessHandle = {
      cancel: () => {},
      killTree: async () => {
        state.killed++;
      },
      done: (async () => {
        if (opts.emit !== undefined) o.onData(opts.emit);
        return { code: codes[Math.min(i, codes.length - 1)] };
      })(),
    };
    return h;
  };
  return { run, get calls() { return state.calls; }, get killed() { return state.killed; } };
}

describe("isStartFailure / exitCause", () => {
  it("recognises the unsigned and signed forms only", () => {
    expect(isStartFailure(START)).toBe(true);
    expect(isStartFailure(-1073741502)).toBe(true);
    expect(isStartFailure(1)).toBe(false);
    expect(isStartFailure(0)).toBe(false);
    expect(exitCause(START)).toContain("0xC0000142");
    expect(exitCause(-1073741502)).toBe(exitCause(START));
    expect(exitCause(1)).toBeUndefined();
    expect(exitCause(0)).toBeUndefined();
  });
});

describe("withStartRetry", () => {
  const argv = ["x"];
  const opts = { cwd: "/", onData: () => {} };
  const retry = (run: Run) => withStartRetry(run, { delayMs: 1 });

  it("retries a bare start failure then returns the success", async () => {
    const f = fakeRun([START, 0]);
    const h = retry(f.run)(argv, opts);
    expect(await h.done).toEqual({ code: 0 });
    expect(f.calls).toBe(2);
  });

  it("returns the failure code when retries are exhausted", async () => {
    const f = fakeRun([START, START, START]);
    const h = retry(f.run)(argv, opts);
    expect(await h.done).toEqual({ code: START });
    expect(f.calls).toBe(2);
  });

  it("does not retry when output was seen", async () => {
    const f = fakeRun([START], { emit: "partial" });
    let seen = "";
    const h = retry(f.run)(argv, { cwd: "/", onData: (d) => (seen += d) });
    expect(await h.done).toEqual({ code: START });
    expect(f.calls).toBe(1);
    expect(seen).toBe("partial");
  });

  it("does not retry after killTree", async () => {
    const state = { calls: 0 };
    const run: Run = (_a, _o) => {
      state.calls++;
      let res: (r: { code: number }) => void = () => {};
      const done = new Promise<{ code: number }>((r) => (res = r));
      return {
        cancel: () => res({ code: START }),
        killTree: async () => res({ code: START }),
        done,
      };
    };
    const h = retry(run)(argv, opts);
    await h.killTree();
    expect(await h.done).toEqual({ code: START });
    expect(state.calls).toBe(1);
  });

  it("does not retry an ordinary non-zero exit", async () => {
    const f = fakeRun([3]);
    const h = retry(f.run)(argv, opts);
    expect(await h.done).toEqual({ code: 3 });
    expect(f.calls).toBe(1);
  });
});
